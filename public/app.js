// File: public/app.js
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

// Stop client button
document.getElementById('stopClient').addEventListener('click', async () => {
  try {
    const response = await fetch('/stop-client', { method: 'POST' });
    const data = await response.json();
    
    if(data.success) {
      document.getElementById('clientStatus').textContent = 'Client Status: Stopped';
      document.getElementById('clientStatus').className = 'mb-3 text-danger';
      document.getElementById('qrSection').classList.add('hidden');
      document.getElementById('stopClient').classList.add('hidden');
      document.getElementById('initClient').disabled = false;
      
      // Stop status checking
      if(statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
    } else {
      alert('Error stopping client: ' + data.error);
    }
  } catch (error) {
    alert('Error: ' + error.message);
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
    
    if(data.isStopping) {
      clientStatusElem.className = 'mb-3 text-danger';
      clientStatusElem.textContent = 'Client Status: Stopping...';
      document.getElementById('qrSection').classList.add('hidden');
      document.getElementById('stopClient').classList.add('hidden');
      return;
    }
    
    if(data.clientReady) {
      clientStatusElem.className = 'mb-3 text-success';
      clientStatusElem.textContent = 'Client Status: Ready ✓';
      document.getElementById('qrSection').classList.add('hidden');
      document.getElementById('stopClient').classList.add('hidden');
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
      
      // Show QR code and stop button
      document.getElementById('qrSection').classList.remove('hidden');
      document.getElementById('stopClient').classList.remove('hidden');
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
      document.getElementById('stopClient').classList.remove('hidden');
      qrCheckAttempts++;
      
      if (qrCheckAttempts > MAX_QR_CHECK_ATTEMPTS) {
        clientStatusElem.className = 'mb-3 text-danger';
        clientStatusElem.textContent = 'Client Status: Timeout. Please try again.';
        document.getElementById('initClient').disabled = false;
        document.getElementById('stopClient').classList.add('hidden');
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
        `Processed: ${data.jobStatus.processed} / ${data.jobStatus.total} (Success: ${data.jobStatus.success}, Failed: ${data.jobStatus.failed})`;
      
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
});