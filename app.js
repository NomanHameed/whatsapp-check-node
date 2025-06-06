const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const express = require("express");
const multer = require("multer");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

// Session configuration for production
app.use(
  session({
    secret: process.env.SESSION_SECRET || "noman-change-karka-jo-marzi-krdi",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS in production
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true
    },
  }),
);

let latestQR = null;
let shouldStopClient = false;

// Multer configuration - use /tmp for Vercel
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = process.env.NODE_ENV === 'production' ? '/tmp/uploads' : './uploads';
    // Create directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});

const upload = multer({ storage: storage });

// Directory paths - use /tmp for production (Vercel's writable directory)
const getDirectoryPaths = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    outputDir: isProduction ? '/tmp/profile_pics' : path.join(__dirname, "profile_pics"),
    uploadsDir: isProduction ? '/tmp/uploads' : path.join(__dirname, "uploads"),
    resultsDir: isProduction ? '/tmp/results' : path.join(__dirname, "results")
  };
};

const { outputDir, uploadsDir, resultsDir } = getDirectoryPaths();

// Create necessary directories
[outputDir, uploadsDir, resultsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Set up Express app
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static file serving
if (process.env.NODE_ENV !== 'production') {
  app.use("/profile_pics", express.static("profile_pics"));
  app.use("/results", express.static("results"));
} else {
  // In production, serve from /tmp directories
  app.use("/profile_pics", express.static("/tmp/profile_pics"));
  app.use("/results", express.static("/tmp/results"));
}

// Initialize WhatsApp client with local authentication
let client = null;
let isClientReady = false;
let processingJob = false;
let currentJobStatus = { total: 0, processed: 0, success: 0, failed: 0 };

function initializeClient() {
  return new Promise((resolve, reject) => {
    shouldStopClient = false;
    if (client) {
      try {
        client.destroy();
      } catch (e) {
        console.log("Error destroying client:", e);
      }
    }
    isClientReady = false;
    latestQR = null;

    console.log("Initializing new WhatsApp client...");
    
    // Modified puppeteer config for Vercel
    const puppeteerConfig = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu"
      ],
    };

    // In production, don't use LocalAuth as it requires persistent storage
    const authStrategy = process.env.NODE_ENV === 'production' 
      ? undefined // Use default (no persistent auth)
      : new LocalAuth();

    client = new Client({
      authStrategy,
      puppeteer: puppeteerConfig,
    });

    client.on("qr", (qr) => {
      if (shouldStopClient) {
        console.log("QR generation stopped by user");
        client.destroy();
        reject(new Error("QR generation stopped by user"));
        return;
      }

      console.log("QR RECEIVED. QR code is now available for web interface.");
      qrcode.generate(qr, { small: true });
      latestQR = qr;
      console.log("QR code updated and available for frontend");
    });

    client.on("ready", () => {
      console.log("WhatsApp client is ready!");
      isClientReady = true;
      latestQR = null;
      shouldStopClient = false;
      resolve(true);
    });

    client.on("authenticated", () => {
      console.log("WhatsApp client authenticated!");
      latestQR = null;
      shouldStopClient = false;
    });

    client.on("disconnected", (reason) => {
      console.log("Client was disconnected:", reason);
      isClientReady = false;
      latestQR = null;
    });

    client.on("auth_failure", (msg) => {
      console.error("Authentication failed:", msg);
      latestQR = null;
      reject(new Error("Authentication failed: " + msg));
    });

    client.initialize().catch((err) => {
      console.error("Error initializing WhatsApp client:", err);
      reject(err);
    });

    setTimeout(() => {
      if (!isClientReady && !shouldStopClient) {
        console.log("Auto-stopping client initialization due to timeout");
        stopClientInitialization();
        reject(new Error("Client initialization timeout"));
      }
    }, 180000); // 2 minutes timeout
  });
}

app.get("/", (req, res) => {
  res.redirect("/app");
});

app.get("/app", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function requireAuth(req, res, next) {
  if (req.session && req.session.isLoggedIn) {
    return next();
  } else {
    return res.sendFile(path.join(__dirname, "public", "login.html"));
  }
}

function stopClientInitialization() {
  console.log("Stopping WhatsApp client initialization...");
  shouldStopClient = true;
  latestQR = null;

  if (client) {
    try {
      client.destroy();
      console.log("Client destroyed successfully");
    } catch (error) {
      console.error("Error destroying client:", error);
    }
  }

  client = null;
  isClientReady = false;
}

async function checkWhatsAppNumber(phoneNumber) {
  try {
    const formattedNumber = `${phoneNumber}@c.us`;
    const contactInfo = await client.getContactById(formattedNumber);

    const result = {
      phoneNumber,
      isRegistered: false,
      name: "Not available",
      profilePicUrl: "Not available",
      profilePicPath: null,
    };

    if (contactInfo) {
      result.isRegistered = true;
      result.name = contactInfo.name || contactInfo.pushname || "Not available";

      try {
        const profilePic = await client.getProfilePicUrl(formattedNumber);
        if (profilePic) {
          result.profilePicUrl = profilePic;
          const picPath = await downloadProfilePicture(profilePic, phoneNumber);
          if (picPath) {
            result.profilePicPath = picPath;
          }
        }
      } catch (err) {
        console.log(
          `Could not retrieve profile picture for ${phoneNumber}:`,
          err.message,
        );
      }
    }

    return result;
  } catch (error) {
    console.log(`Error checking number ${phoneNumber}:`, error.message);
    return {
      phoneNumber,
      isRegistered: error.message.includes("404") ? false : "Error",
      name: "Error",
      profilePicUrl: error.message,
      profilePicPath: null,
    };
  }
}

async function downloadProfilePicture(url, phoneNumber) {
  try {
    const response = await axios({
      method: "GET",
      url: url,
      responseType: "stream",
    });

    const filePath = path.join(outputDir, `${phoneNumber}.jpg`);
    const writer = fs.createWriteStream(filePath);

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        console.log(`Profile picture saved to: ${filePath}`);
        resolve(filePath);
      });
      writer.on("error", (err) => {
        console.error(`Error saving profile picture: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error("Error downloading profile picture:", error.message);
    return null;
  }
}

async function processExcelFile(filePath) {
  try {
    currentJobStatus = { total: 0, processed: 0, success: 0, failed: 0 };
    processingJob = true;
    const workbook = xlsx.readFile(filePath);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(worksheet);
    let phoneNumbers = [];
    
    if (data.length > 0) {
      const firstKey = Object.keys(data[0])[0];
      phoneNumbers = data
        .map((row) => String(row[firstKey]).trim())
        .filter((num) => num && num !== "");
    }

    currentJobStatus.total = phoneNumbers.length;
    console.log(`Found ${phoneNumbers.length} phone numbers to process`);
    const resultWorkbook = xlsx.utils.book_new();
    const resultsData = [];

    for (let i = 0; i < phoneNumbers.length; i++) {
      const phoneNumber = phoneNumbers[i];

      console.log(
        `Processing phone number ${i + 1}/${phoneNumbers.length}: ${phoneNumber}`,
      );

      const result = await checkWhatsAppNumber(phoneNumber);

      resultsData.push({
        "Phone Number": phoneNumber,
        "Registered on WhatsApp": result.isRegistered ? "Yes" : "No",
        Name: result.name,
        "Profile Picture URL": result.profilePicUrl,
        "Profile Picture Path": result.profilePicPath || "Not available",
      });

      currentJobStatus.processed = i + 1;
      if (result.isRegistered === true) {
        currentJobStatus.success++;
      } else {
        currentJobStatus.failed++;
      }

      const progressPercent = Math.round(
        (currentJobStatus.processed / currentJobStatus.total) * 100,
      );
      console.log(
        `Progress: ${progressPercent}% (${currentJobStatus.processed}/${currentJobStatus.total}) - Success: ${currentJobStatus.success}, Failed: ${currentJobStatus.failed}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const resultsWorksheet = xlsx.utils.json_to_sheet(resultsData);
    xlsx.utils.book_append_sheet(resultWorkbook, resultsWorksheet, "Results");

    const resultFilename = `whatsapp_check_results_${Date.now()}.xlsx`;
    const resultFilePath = path.join(resultsDir, resultFilename);
    xlsx.writeFile(resultWorkbook, resultFilePath);

    processingJob = false;
    console.log("Processing completed successfully!");
    return { resultFilePath, resultFilename };
  } catch (error) {
    console.error("Error processing Excel file:", error);
    processingJob = false;
    throw error;
  }
}

// All your existing routes remain the same...
app.get("/logout-action", async (req, res) => {
  try {
    if (client) {
      console.log("Cleaning up WhatsApp client on logout...");
      
      try {
        shouldStopClient = true;
        processingJob = false;
        isClientReady = false;
        latestQR = null;
        currentJobStatus = { total: 0, processed: 0, success: 0, failed: 0 };
        
        await client.destroy();
        console.log("WhatsApp client destroyed successfully");
        client = null;
        
      } catch (clientError) {
        console.error("Error cleaning up WhatsApp client:", clientError);
      }
    }
    
    req.session.destroy((err) => {
      if (err) {
        console.error("Session destruction error:", err);
        return res.status(500).send("Logout failed");
      }
      
      console.log("User logged out successfully - session destroyed and client cleaned up");
      res.redirect("/app");
    });
    
  } catch (error) {
    console.error("Logout error:", error);
    req.session.destroy((err) => {
      if (err) {
        console.error("Force session destruction error:", err);
      }
      res.redirect("/app");
    });
  }
});

app.use("/static", requireAuth, express.static("public"));

app.post("/login-action", (req, res) => {
  const { username, password } = req.body;

  console.log("Login attempt:", username);

  const validUsername = process.env.APP_USERNAME || "user";
  const validPassword = process.env.APP_PASSWORD || "password123";

  if (username === validUsername && password === validPassword) {
    req.session.isLoggedIn = true;
    console.log("Login successful - session created");
    return res.redirect("/app");
  } else {
    req.session.isLoggedIn = false;
    console.log("Invalid credentials attempt");
    return res.redirect("/hello?error=invalidCredentials");
  }
});

app.get("/status", requireAuth, (req, res) => {
  console.log(
    "Status request - Client Ready:",
    isClientReady,
    "QR Available:",
    !!latestQR,
    "Processing:",
    processingJob,
    "Should Stop:",
    shouldStopClient,
  );

  res.json({
    clientReady: isClientReady,
    processingJob,
    jobStatus: currentJobStatus,
    qrCode: shouldStopClient ? null : latestQR,
    isStopping: shouldStopClient,
  });
});

app.post("/stop-client", requireAuth, (req, res) => {
  try {
    stopClientInitialization();
    res.json({
      success: true,
      message: "Client initialization stopped successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/upload", requireAuth, upload.single("excelFile"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  if (!isClientReady) {
    return res.status(400).json({
      error: "WhatsApp client is not ready. Please scan the QR code first.",
    });
  }

  if (processingJob) {
    return res.status(400).json({
      error: "Another job is currently processing. Please wait until it finishes.",
    });
  }

  try {
    processExcelFile(req.file.path)
      .then((result) => {
        console.log("File processing completed:", result.resultFilename);
      })
      .catch((error) => {
        console.error("File processing failed:", error);
      });

    res.json({
      success: true,
      message: "File processing started. Check the progress below.",
      processing: true,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/download-result", requireAuth, (req, res) => {
  if (processingJob) {
    return res.json({ processing: true });
  }
  
  const resultFiles = fs
    .readdirSync(resultsDir)
    .filter((file) => file.endsWith(".xlsx"));
    
  if (resultFiles.length > 0) {
    const latestFile = resultFiles
      .map((file) => ({
        name: file,
        time: fs.statSync(path.join(resultsDir, file)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time)[0];

    return res.json({
      processing: false,
      completed: true,
      downloadUrl: `/results/${latestFile.name}`,
    });
  }

  res.json({ processing: false, completed: false });
});

app.get("/init-client", requireAuth, async (req, res) => {
  if (isClientReady) {
    return res.json({
      success: true,
      message: "Client is already initialized and ready",
    });
  }

  try {
    initializeClient().catch((err) => {
      console.error("Client initialization failed:", err);
    });
    res.json({
      success: true,
      message: "Client initialization started. Please wait for QR code...",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Access the WhatsApp Number Checker app in your browser`);
    console.log(
      `The QR code will appear on the web interface when you click "Initialize Client"`,
    );
  });
}

// Export for Vercel
module.exports = app;