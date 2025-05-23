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
let shouldStopClient = false;

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
      // Reset the stop flag
      shouldStopClient = false;
      
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
        // Check if we should stop before processing QR
        if (shouldStopClient) {
          console.log('QR generation stopped by user');
          client.destroy();
          reject(new Error('QR generation stopped by user'));
          return;
        }
        
        console.log('QR RECEIVED. QR code is now available for web interface.');
        qrcode.generate(qr, { small: true });
        latestQR = qr;
        console.log('QR code updated and available for frontend');
      });
  
      client.on('ready', () => {
        console.log('WhatsApp client is ready!');
        isClientReady = true;
        latestQR = null;
        shouldStopClient = false; // Reset flag
        resolve(true);
      });
  
      client.on('authenticated', () => {
        console.log('WhatsApp client authenticated!');
        latestQR = null;
        shouldStopClient = false; // Reset flag
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
  
      // Handle initialization with stop check
      client.initialize().catch(err => {
        console.error('Error initializing WhatsApp client:', err);
        reject(err);
      });
      
      // Set up a timeout to auto-stop after certain time (optional)
      setTimeout(() => {
        if (!isClientReady && !shouldStopClient) {
          console.log('Auto-stopping client initialization due to timeout');
          stopClientInitialization();
          reject(new Error('Client initialization timeout'));
        }
      }, 180000); // 2 minutes timeout
    });
}

function stopClientInitialization() {
    console.log('Stopping WhatsApp client initialization...');
    shouldStopClient = true;
    latestQR = null;
    
    if (client) {
      try {
        client.destroy();
        console.log('Client destroyed successfully');
      } catch (error) {
        console.error('Error destroying client:', error);
      }
    }
    
    // Reset client reference
    client = null;
    isClientReady = false;
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
      phoneNumbers = data.map(row => String(row[firstKey]).trim()).filter(num => num && num !== '');
    }
    
    currentJobStatus.total = phoneNumbers.length;
    console.log(`Found ${phoneNumbers.length} phone numbers to process`);
    
    // Create a new workbook for results
    const resultWorkbook = xlsx.utils.book_new();
    const resultsData = [];
    
    // Process phone numbers with real-time updates
    for (let i = 0; i < phoneNumbers.length; i++) {
      const phoneNumber = phoneNumbers[i];
      
      console.log(`Processing phone number ${i + 1}/${phoneNumbers.length}: ${phoneNumber}`);
      
      const result = await checkWhatsAppNumber(phoneNumber);
      
      resultsData.push({
        'Phone Number': phoneNumber,
        'Registered on WhatsApp': result.isRegistered ? 'Yes' : 'No',
        'Name': result.name,
        'Profile Picture URL': result.profilePicUrl,
        'Profile Picture Path': result.profilePicPath || 'Not available'
      });
      
      // Update progress in real-time
      currentJobStatus.processed = i + 1;
      if (result.isRegistered === true) {
        currentJobStatus.success++;
      } else {
        currentJobStatus.failed++;
      }
      
      // Log progress
      const progressPercent = Math.round((currentJobStatus.processed / currentJobStatus.total) * 100);
      console.log(`Progress: ${progressPercent}% (${currentJobStatus.processed}/${currentJobStatus.total}) - Success: ${currentJobStatus.success}, Failed: ${currentJobStatus.failed}`);
      
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
    console.log('Processing completed successfully!');
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
    console.log('Status request - Client Ready:', isClientReady, 'QR Available:', !!latestQR, 'Processing:', processingJob, 'Should Stop:', shouldStopClient);
    
    if (processingJob) {
      console.log('Current job status:', currentJobStatus);
    }
    
    res.json({
      clientReady: isClientReady,
      processingJob,
      jobStatus: currentJobStatus,
      qrCode: shouldStopClient ? null : latestQR, // Don't send QR if stopping
      isStopping: shouldStopClient
    });
});

app.post('/stop-client', (req, res) => {
    try {
      stopClientInitialization();
      res.json({ 
        success: true, 
        message: 'Client initialization stopped successfully' 
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
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
    // Start processing in background and return immediately
    processExcelFile(req.file.path).then(result => {
      console.log('File processing completed:', result.resultFilename);
    }).catch(error => {
      console.error('File processing failed:', error);
    });
    
    res.json({
      success: true,
      message: 'File processing started. Check the progress below.',
      processing: true
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// New endpoint to get the download link when processing is complete
app.get('/download-result', (req, res) => {
  if (processingJob) {
    return res.json({ processing: true });
  }
  
  // Check if there's a completed result file
  const resultFiles = fs.readdirSync(resultsDir).filter(file => file.endsWith('.xlsx'));
  if (resultFiles.length > 0) {
    // Get the most recent file
    const latestFile = resultFiles
      .map(file => ({
        name: file,
        time: fs.statSync(path.join(resultsDir, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time)[0];
    
    return res.json({
      processing: false,
      completed: true,
      downloadUrl: `/results/${latestFile.name}`
    });
  }
  
  res.json({ processing: false, completed: false });
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
const HtmlContent = `<!DOCTYPE html>
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
    .btn-danger { background-color: #dc3545; border-color: #dc3545; }
    .text-success { color: #25D366 !important; }
    .progress-bar { background-color: #128C7E; }
    body { background-color: #f5f5f5; }
    .btn-group { gap: 10px; }
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
          <div class="mt-3">
            <small class="text-muted">QR code expires after some time. Click "Stop" if you want to cancel.</small>
          </div>
        </div>
        
        <div class="btn-group">
          <button id="initClient" class="btn btn-primary">Initialize Client</button>
          <button id="stopClient" class="btn btn-danger hidden">Stop QR Generation</button>
        </div>
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
          <div id="progressBar" class="progress-bar progress-bar-striped progress-bar-animated" role="progressbar" style="width: 0%;" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>
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

// Write the updated app.js file
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
      console.log('File upload successful, processing started');
      // Start checking for progress updates
      startProgressCheck();
    } else {
      alert('Error: ' + data.error);
      document.getElementById('uploadBtn').disabled = false;
      document.getElementById('progressSection').classList.add('hidden');
    }
  } catch (error) {
    alert('Error: ' + error.message);
    document.getElementById('uploadBtn').disabled = false;
    document.getElementById('progressSection').classList.add('hidden');
  }
});

// Progress check function
async function checkProgress() {
  try {
    const response = await fetch('/download-result');
    const data = await response.json();
    
    if (data.completed) {
      // Processing completed
      document.getElementById('resultMessage').textContent = 'File processed successfully!';
      document.getElementById('downloadLink').href = data.downloadUrl;
      document.getElementById('downloadLink').classList.remove('hidden');
      document.getElementById('resultSection').classList.remove('hidden');
      document.getElementById('uploadBtn').disabled = false;
      
      // Update progress bar to 100%
      document.getElementById('progressBar').style.width = '100%';
      document.getElementById('progressBar').setAttribute('aria-valuenow', 100);
      document.getElementById('progressBar').textContent = '100%';
      document.getElementById('progressBar').classList.remove('progress-bar-animated');
      
      // Stop checking progress
      if (window.progressInterval) {
        clearInterval(window.progressInterval);
        window.progressInterval = null;
      }
      
      return true; // Processing completed
    }
    
    return false; // Still processing
  } catch (error) {
    console.error('Error checking progress:', error);
    return false;
  }
}

// Start progress check interval
function startProgressCheck() {
  if (!window.progressInterval) {
    window.progressInterval = setInterval(async () => {
      const completed = await checkProgress();
      if (completed) {
        clearInterval(window.progressInterval);
        window.progressInterval = null;
      }
    }, 2000); // Check every 2 seconds
  }
}

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
    if(data.processingJob && data.jobStatus.total > 0) {
      const progress = Math.round((data.jobStatus.processed / data.jobStatus.total) * 100);
      
      console.log('Updating progress:', progress + '%', data.jobStatus);
      
      document.getElementById('progressBar').style.width = progress + '%';
      document.getElementById('progressBar').setAttribute('aria-valuenow', progress);
      document.getElementById('progressBar').textContent = progress + '%';
      
      document.getElementById('progressDetails').textContent = 
        \`Processed: \${data.jobStatus.processed} / \${data.jobStatus.total} (Success: \${data.jobStatus.success}, Failed: \${data.jobStatus.failed})\`;
      
      document.getElementById('progressSection').classList.remove('hidden');
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
  if(window.progressInterval) {
    clearInterval(window.progressInterval);
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