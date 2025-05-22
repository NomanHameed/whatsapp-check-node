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
        console.log('QR RECEIVED. QR code is now available for web interface.');
        // Also show in terminal for backup
        qrcode.generate(qr, { small: true });
        
        // Store the QR code for the frontend to access
        latestQR = qr;
        console.log('QR code updated and available for frontend');
      });
  
      client.on('ready', () => {
        console.log('WhatsApp client is ready!');
        isClientReady = true;
        latestQR = null; // Clear QR code when ready
        resolve(true);
      });
  
      client.on('authenticated', () => {
        console.log('WhatsApp client authenticated!');
        latestQR = null; // Clear QR code when authenticated
      });
  
      client.on('disconnected', (reason) => {
        console.log('Client was disconnected:', reason);
        isClientReady = false;
        latestQR = null;
      });

      client.on('auth_failure', (msg) => {
        console.error('Authentication failed:', msg);
        latestQR = null;
        reject(new Error('Authentication failed: ' + msg));
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
    console.log('Status request - Client Ready:', isClientReady, 'QR Available:', !!latestQR);
    
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
    return res.json({ success: true, message: 'Client is already initialized and ready' });
  }
  
  try {
    // Don't await here, let it initialize in background
    initializeClient().catch(err => {
      console.error('Client initialization failed:', err);
    });
    res.json({ success: true, message: 'Client initialization started. Please wait for QR code...' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Create the HTML content if it doesn't exist
const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Number Checker</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.0/build/qrcode.min.js"></script>
  <style>
    .hidden { display: none; }
    #qrcode { width: 256px; height: 256px; margin: 0 auto; }
    .progress { height: 25px; }
    .container { max-width: 800px; }
    .card { margin-bottom: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .card-header { background-color: #f8f9fa; padding: 12px 20px; }
    .btn-primary { background-color: #128C7E; border-color: #128C7E; }
    .btn-primary:hover, .btn-primary:focus { background-color: #075E54; border-color: #075E54; }
    .btn-success { background-color: #25D366; border-color: #25D366; }
    .btn-success:hover, .btn-success:focus { background-color: #1da851; border-color: #1da851; }
    .text-success { color: #25D366 !important; }
    .progress-bar { background-color: #128C7E; }
    body { background-color: #f5f5f5; }
  </style>
</head>
<body>
  <div class="container mt-5">
    <h1 class="text-center mb-4">WhatsApp Number Checker</h1>
    
    <div class="card mb-4">
      <div class="card-header">
        <h5>Step 1: Initialize WhatsApp Client</h5>
      </div>
      <div class="card-body">
        <div id="clientStatus" class="mb-3">Client Status: Not Initialized</div>
        
        <div id="qrSection" class="text-center mb-3 hidden">
          <p>Scan this QR code with your WhatsApp app:</p>
          <div id="qrcode"></div>
        </div>
        
        <button id="initClient" class="btn btn-primary">Initialize Client</button>
      </div>
    </div>
    
    <div class="card mb-4">
      <div class="card-header">
        <h5>Step 2: Upload Excel File with Phone Numbers</h5>
      </div>
      <div class="card-body">
        <form id="uploadForm">
          <div class="mb-3">
            <label for="excelFile" class="form-label">Excel File (First column should contain phone numbers)</label>
            <input class="form-control" type="file" id="excelFile" name="excelFile" accept=".xlsx,.xls">
            <div class="form-text mt-2">Note: Phone numbers should be in international format without any special characters (e.g., 12345678901).</div>
          </div>
          <button type="submit" class="btn btn-success" id="uploadBtn" disabled>Upload and Process</button>
        </form>
      </div>
    </div>
    
    <div id="progressSection" class="card mb-4 hidden">
      <div class="card-header">
        <h5>Processing Status</h5>
      </div>
      <div class="card-body">
        <div class="progress mb-3">
          <div id="progressBar" class="progress-bar" role="progressbar" style="width: 0%;" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>
        </div>
        <div id="progressDetails" class="mb-2">
          Processed: 0 / 0 (Success: 0, Failed: 0)
        </div>
        <div class="small text-muted">Processing may take some time. Please do not close this window.</div>
      </div>
    </div>
    
    <div id="resultSection" class="card mb-4 hidden">
      <div class="card-header">
        <h5>Results</h5>
      </div>
      <div class="card-body">
        <p id="resultMessage"></p>
        <a id="downloadLink" href="#" class="btn btn-primary hidden">Download Results</a>
      </div>
    </div>
  </div>
  
  <script src="app.js"></script>
</body>
</html>`;

// Create public directory and files
if (!fs.existsSync(path.join(__dirname, 'public'))) {
  fs.mkdirSync(path.join(__dirname, 'public'));
}

// Only write HTML if it doesn't exist
if (!fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
  fs.writeFileSync(path.join(__dirname, 'public', 'index.html'), htmlContent);
}

// Write the app.js file
const appJsContent = `// File: public/app.js
let statusInterval;
let qrCheckAttempts = 0;
const MAX_QR_CHECK_ATTEMPTS = 30; // Try for about 60 seconds

// Initialize client
document.getElementById('initClient').addEventListener('click', async () => {
  try {
    document.getElementById('clientStatus').textContent = 'Client Status: Initializing...';
    document.getElementById('initClient').disabled = true;
    
    const response = await fetch('/init-client');
    const data = await response.json();
    
    if(data.success) {
      console.log('Client initialization started');
      startStatusCheck();
    } else {
      alert('Error initializing client: ' + data.error);
      document.getElementById('initClient').disabled = false;
    }
  } catch (error) {
    alert('Error: ' + error.message);
    document.getElementById('initClient').disabled = false;
  }
});

// Upload form
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const fileInput = document.getElementById('excelFile');
  if(!fileInput.files[0]) {
    alert('Please select an Excel file');
    return;
  }
  
  const formData = new FormData();
  formData.append('excelFile', fileInput.files[0]);
  
  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('progressSection').classList.remove('hidden');
  document.getElementById('resultSection').classList.add('hidden');
  
  try {
    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });
    
    const data = await response.json();
    
    if(data.success) {
      document.getElementById('resultMessage').textContent = data.message;
      document.getElementById('downloadLink').href = data.resultFile;
      document.getElementById('downloadLink').classList.remove('hidden');
      document.getElementById('resultSection').classList.remove('hidden');
    } else {
      alert('Error: ' + data.error);
      document.getElementById('uploadBtn').disabled = false;
    }
  } catch (error) {
    alert('Error: ' + error.message);
    document.getElementById('uploadBtn').disabled = false;
  }
});

// Status check function
async function checkStatus() {
  try {
    const response = await fetch('/status');
    const data = await response.json();
    
    console.log('Status check:', data);
    
    // Update client status
    const clientStatusElem = document.getElementById('clientStatus');
    
    if(data.clientReady) {
      clientStatusElem.className = 'mb-3 text-success';
      clientStatusElem.textContent = 'Client Status: Ready ✓';
      document.getElementById('qrSection').classList.add('hidden');
      document.getElementById('uploadBtn').disabled = false;
      document.getElementById('initClient').disabled = true;
      qrCheckAttempts = 0; // Reset counter
      
      // Stop checking once ready
      if(statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
    } else if(data.qrCode) {
      clientStatusElem.className = 'mb-3 text-warning';
      clientStatusElem.textContent = 'Client Status: Please scan the QR code below';
      console.log('QR code received, displaying...');
      
      // Show QR code
      document.getElementById('qrSection').classList.remove('hidden');
      const qrCodeElement = document.getElementById('qrcode');
      qrCodeElement.innerHTML = '';
      
      // Generate QR code
      QRCode.toCanvas(qrCodeElement, data.qrCode, { 
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      }, function(error) {
        if (error) {
          console.error('Error generating QR code:', error);
          qrCodeElement.innerHTML = '<p class="text-danger">Error generating QR code</p>';
        } else {
          console.log('QR code displayed successfully');
        }
      });
      qrCheckAttempts = 0; // Reset counter
    } else {
      clientStatusElem.className = 'mb-3 text-info';
      clientStatusElem.textContent = 'Client Status: Waiting for QR code...';
      qrCheckAttempts++;
      
      if (qrCheckAttempts > MAX_QR_CHECK_ATTEMPTS) {
        clientStatusElem.className = 'mb-3 text-danger';
        clientStatusElem.textContent = 'Client Status: Timeout. Please try again.';
        document.getElementById('initClient').disabled = false;
        clearInterval(statusInterval);
        statusInterval = null;
      }
    }
    
    // Update job status if processing
    if(data.processingJob) {
      const progress = data.jobStatus.total > 0 ? 
        Math.round((data.jobStatus.processed / data.jobStatus.total) * 100) : 0;
      
      document.getElementById('progressBar').style.width = progress + '%';
      document.getElementById('progressBar').setAttribute('aria-valuenow', progress);
      document.getElementById('progressBar').textContent = progress + '%';
      
      document.getElementById('progressDetails').textContent = 
        \`Processed: \${data.jobStatus.processed} / \${data.jobStatus.total} (Success: \${data.jobStatus.success}, Failed: \${data.jobStatus.failed})\`;
      
      document.getElementById('progressSection').classList.remove('hidden');
    } else if(data.jobStatus.processed > 0) {
      // Job completed
      document.getElementById('uploadBtn').disabled = false;
    }
  } catch (error) {
    console.error('Error checking status:', error);
  }
}

// Start status check interval
function startStatusCheck() {
  if(!statusInterval) {
    statusInterval = setInterval(checkStatus, 2000); // Check every 2 seconds
    checkStatus(); // Immediate first check
  }
}

// Stop status check interval on page unload
window.addEventListener('beforeunload', () => {
  if(statusInterval) {
    clearInterval(statusInterval);
  }
});`;

// Write the app.js file
fs.writeFileSync(path.join(__dirname, 'public', 'app.js'), appJsContent);

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Access the WhatsApp Number Checker app in your browser`);
  console.log(`The QR code will appear on the web interface when you click "Initialize Client"`);
});