const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const express = require('express');
const multer = require('multer');
const app = express();
const PORT = 3000;

let latestQR = null;

// Set up file upload configuration with multer
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, './uploads');
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// Create necessary directories
const outputDir = path.join(__dirname, 'profile_pics');
const uploadsDir = path.join(__dirname, 'uploads');
const resultsDir = path.join(__dirname, 'results');

[outputDir, uploadsDir, resultsDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

// Set up Express app
app.use(express.static('public'));
app.use('/profile_pics', express.static('profile_pics'));
app.use('/results', express.static('results'));

// Initialize WhatsApp client with local authentication
let client = null;
let isClientReady = false;
let processingJob = false;
let currentJobStatus = { total: 0, processed: 0, success: 0, failed: 0 };

// Function to initialize WhatsApp client
function initializeClient() {
    return new Promise((resolve, reject) => {
      // Destroy any existing client
      if (client) {
        try {
          client.destroy();
        } catch (e) {
          console.log('Error destroying client:', e);
        }
      }
      
      // Reset status variables
      isClientReady = false;
      latestQR = null;
      
      console.log('Initializing new WhatsApp client...');
      
      client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
      });
  
      client.on('qr', (qr) => {
        console.log('QR RECEIVED. Scan with your WhatsApp app:');
        qrcode.generate(qr, { small: true });
        // Store the QR code for the frontend to access
        latestQR = qr;
        console.log('QR code updated and available for frontend');
      });
  
      client.on('ready', () => {
        console.log('WhatsApp client is ready!');
        isClientReady = true;
        resolve(true);
      });
  
      client.on('disconnected', () => {
        console.log('Client was disconnected');
        isClientReady = false;
      });
  
      client.initialize().catch(err => {
        console.error('Error initializing WhatsApp client:', err);
        reject(err);
      });
    });
  }
  

// Function to check if a number is registered on WhatsApp
async function checkWhatsAppNumber(phoneNumber) {
  try {
    // Format phone number (add @ for WhatsApp ID format)
    const formattedNumber = `${phoneNumber}@c.us`;
    
    // Check if the number exists on WhatsApp
    const contactInfo = await client.getContactById(formattedNumber);
    
    const result = {
      phoneNumber,
      isRegistered: false,
      name: 'Not available',
      profilePicUrl: 'Not available',
      profilePicPath: null
    };
    
    if (contactInfo) {
      result.isRegistered = true;
      result.name = contactInfo.name || contactInfo.pushname || 'Not available';
      
      // Try to get profile picture
      try {
        const profilePic = await client.getProfilePicUrl(formattedNumber);
        if (profilePic) {
          result.profilePicUrl = profilePic;
          // Download profile picture
          const picPath = await downloadProfilePicture(profilePic, phoneNumber);
          if (picPath) {
            result.profilePicPath = picPath;
          }
        }
      } catch (err) {
        console.log(`Could not retrieve profile picture for ${phoneNumber}:`, err.message);
      }
    }
    
    return result;
  } catch (error) {
    console.log(`Error checking number ${phoneNumber}:`, error.message);
    return {
      phoneNumber,
      isRegistered: error.message.includes('404') ? false : 'Error',
      name: 'Error',
      profilePicUrl: error.message,
      profilePicPath: null
    };
  }
}

// Function to download profile picture
async function downloadProfilePicture(url, phoneNumber) {
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });
    
    const filePath = path.join(outputDir, `${phoneNumber}.jpg`);
    const writer = fs.createWriteStream(filePath);
    
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log(`Profile picture saved to: ${filePath}`);
        resolve(filePath);
      });
      writer.on('error', (err) => {
        console.error(`Error saving profile picture: ${err.message}`);
        reject(err);
      });
    });
  } catch (error) {
    console.error('Error downloading profile picture:', error.message);
    return null;
  }
}

// Process an Excel file with phone numbers
async function processExcelFile(filePath) {
  try {
    // Reset job status
    currentJobStatus = { total: 0, processed: 0, success: 0, failed: 0 };
    processingJob = true;
    
    // Read the Excel file
    const workbook = xlsx.readFile(filePath);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(worksheet);
    
    // Extract phone numbers from the first column (assuming the first column contains phone numbers)
    let phoneNumbers = [];
    if (data.length > 0) {
      // Get the first key which should be the column name for phone numbers
      const firstKey = Object.keys(data[0])[0];
      phoneNumbers = data.map(row => String(row[firstKey]).trim());
    }
    
    currentJobStatus.total = phoneNumbers.length;
    console.log(`Found ${phoneNumbers.length} phone numbers to process`);
    
    // Create a new workbook for results
    const resultWorkbook = xlsx.utils.book_new();
    const resultsData = [];
    
    // Process phone numbers
    for (const phoneNumber of phoneNumbers) {
      // Skip empty phone numbers
      if (!phoneNumber) {
        currentJobStatus.processed++;
        currentJobStatus.failed++;
        continue;
      }
      
      console.log(`Processing phone number: ${phoneNumber}`);
      const result = await checkWhatsAppNumber(phoneNumber);
      
      resultsData.push({
        'Phone Number': phoneNumber,
        'Registered on WhatsApp': result.isRegistered ? 'Yes' : 'No',
        'Name': result.name,
        'Profile Picture URL': result.profilePicUrl,
        'Profile Picture Path': result.profilePicPath || 'Not available'
      });
      
      currentJobStatus.processed++;
      if (result.isRegistered) {
        currentJobStatus.success++;
      } else {
        currentJobStatus.failed++;
      }
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Create a worksheet with the results
    const resultsWorksheet = xlsx.utils.json_to_sheet(resultsData);
    xlsx.utils.book_append_sheet(resultWorkbook, resultsWorksheet, 'Results');
    
    // Save the workbook
    const resultFilename = `whatsapp_check_results_${Date.now()}.xlsx`;
    const resultFilePath = path.join(resultsDir, resultFilename);
    xlsx.writeFile(resultWorkbook, resultFilePath);
    
    processingJob = false;
    return { resultFilePath, resultFilename };
  } catch (error) {
    console.error('Error processing Excel file:', error);
    processingJob = false;
    throw error;
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
    console.log('Status request, sending QR:', latestQR ? 'QR code available' : 'No QR code');
    
    res.json({
      clientReady: isClientReady,
      processingJob,
      jobStatus: currentJobStatus,
      qrCode: latestQR
    });
  });

app.post('/upload', upload.single('excelFile'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  if (!isClientReady) {
    return res.status(400).json({ error: 'WhatsApp client is not ready. Please scan the QR code first.' });
  }
  
  if (processingJob) {
    return res.status(400).json({ error: 'Another job is currently processing. Please wait until it finishes.' });
  }
  
  try {
    const result = await processExcelFile(req.file.path);
    res.json({
      success: true,
      message: 'File processed successfully',
      resultFile: `/results/${result.resultFilename}`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/init-client', async (req, res) => {
  if (isClientReady) {
    return res.json({ success: true, message: 'Client is already initialized' });
  }
  
  try {
    await initializeClient();
    res.json({ success: true, message: 'Client initialization started' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Read the fixed HTML content from file
const htmlContent = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

// Create public directory and index.html file
if (!fs.existsSync(path.join(__dirname, 'public'))) {
  fs.mkdirSync(path.join(__dirname, 'public'));
  // Write the HTML content to the index.html file
  fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), htmlContent);
} else {
  // Ensure we're not overwriting an existing index.html every time
  if (!fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
    fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), htmlContent);
  }
}

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Access the WhatsApp Number Checker app in your browser`);
});