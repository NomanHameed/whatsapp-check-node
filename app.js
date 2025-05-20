const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Create an output directory for saving profile pictures
const outputDir = path.join(__dirname, 'profile_pics');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir);
}

// Initialize WhatsApp client with local authentication
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Generate QR code for authentication
client.on('qr', (qr) => {
    console.log('QR RECEIVED: Scan this with your WhatsApp app:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('Client is ready! Now you can check numbers.');
    
    // Get phone number from command line arguments
    const phoneNumber = process.argv[2];
    
    if (phoneNumber) {
        checkWhatsAppNumber(phoneNumber);
    } else {
        console.log('Please provide a phone number as a command line argument.');
        console.log('Usage: node app.js <phone_number>');
        console.log('Example: node app.js 12345678901');
        process.exit(1);
    }
});

// Function to check if a number is registered on WhatsApp
async function checkWhatsAppNumber(phoneNumber) {
    try {
        // Format phone number (add @ for WhatsApp ID format)
        const formattedNumber = `${phoneNumber}@c.us`;
        
        // Check if the number exists on WhatsApp
        const contactInfo = await client.getContactById(formattedNumber);
        
        if (contactInfo) {
            console.log('✅ Number is registered on WhatsApp');
            console.log(`Name: ${contactInfo.name || contactInfo.pushname || 'Not available'}`);
            
            // Try to get profile picture
            try {
                const profilePic = await client.getProfilePicUrl(formattedNumber);
                
                if (profilePic) {
                    console.log('Profile picture URL:', profilePic);
                    
                    // Download profile picture
                    await downloadProfilePicture(profilePic, phoneNumber);
                } else {
                    console.log('No profile picture available');
                }
            } catch (err) {
                console.log('Could not retrieve profile picture:', err.message);
            }
        } else {
            console.log('❌ Number is not registered on WhatsApp');
        }
    } catch (error) {
        if (error.message.includes('404')) {
            console.log('❌ Number is not registered on WhatsApp');
        } else {
            console.log('Error checking number:', error.message);
        }
    } finally {
        // Disconnect the client
        await client.destroy();
        process.exit(0);
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
                resolve();
            });
            writer.on('error', reject);
        });
    } catch (error) {
        console.error('Error downloading profile picture:', error.message);
    }
}

// Initialize the client
client.initialize().catch(err => {
    console.error('Error initializing WhatsApp client:', err);
    process.exit(1);
});
