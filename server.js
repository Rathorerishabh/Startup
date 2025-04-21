// Import the improved heart rate algorithm
const { processHeartRate } = require('./heartRateProcessor');

const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const PORT = 8080;

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Latest received data for real-time view
const realtimeData = {
  lastUpdated: Date.now(),
  values: Array(500).fill(0),
  heartRate: 0,
  heartRateZone: "Rest",
  heartRateQuality: 0,
  heartRateTrend: "stable",
  fingerDetected: false
};

// Track active uploads
const activeUploads = {};

// WebSocket connection handling
wss.on('connection', function connection(ws) {
  console.log('New WebSocket client connected');
  
  // Send initial data
  ws.send(JSON.stringify({ 
    type: 'initial',
    data: realtimeData.values,
    heartRate: realtimeData.heartRate,
    heartRateZone: realtimeData.heartRateZone,
    heartRateQuality: realtimeData.heartRateQuality,
    heartRateTrend: realtimeData.heartRateTrend,
    fingerDetected: realtimeData.fingerDetected,
    display_value: realtimeData.display_value || "No signal",
    display_details: realtimeData.display_details || ""
  }));
  
  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Function to broadcast data to all WebSocket clients
function broadcastData(data, hrInfo) {
  realtimeData.lastUpdated = Date.now();
  
  // Update stored data
  realtimeData.values = data;
  if (hrInfo) {
    realtimeData.heartRate = hrInfo.heartRate || 0;
    realtimeData.heartRateZone = hrInfo.zone || "Rest";
    realtimeData.heartRateQuality = hrInfo.quality || 0;
    realtimeData.heartRateTrend = hrInfo.trend || "stable";
    realtimeData.fingerDetected = hrInfo.fingerDetected;
    realtimeData.display_value = hrInfo.display_value;
    realtimeData.display_details = hrInfo.display_details;
  }
  
  // Send to all connected WebSocket clients
  wss.clients.forEach(function each(client) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ 
        type: 'update',
        data: data,
        heartRate: realtimeData.heartRate,
        heartRateZone: realtimeData.heartRateZone,
        heartRateQuality: realtimeData.heartRateQuality,
        heartRateTrend: realtimeData.heartRateTrend,
        fingerDetected: realtimeData.fingerDetected,
        display_value: realtimeData.display_value,
        display_details: realtimeData.display_details
      }));
    }
  });
}

// Get network interfaces to display server IP
const getIpAddress = () => {
  const interfaces = os.networkInterfaces();
  for(const name of Object.keys(interfaces)) {
    for(const iface of interfaces[name]) {
      if(iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
};

// Create data directory if it doesn't exist
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

// Middleware - Increased JSON limit for larger uploads
app.use(bodyParser.json({
  limit: '50mb',
  extended: true
}));

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Simple test endpoint
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to receive real-time data
app.post('/api/realtime-data', (req, res) => {
  const { device_id, data } = req.body;
  
  if (!device_id || !data || !Array.isArray(data)) {
    console.log('Invalid realtime data format received');
    return res.status(400).send('Invalid data format');
  }
  
  console.log(`Received realtime data from ${device_id} with ${data.length} samples`);
  
  // Process heart rate from PPG data using improved algorithm
  const hrInfo = processHeartRate(data);
  
  // Broadcast data to WebSocket clients
  broadcastData(data, hrInfo);
  
  res.status(200).send('Realtime data received');
});

// Endpoint to receive sensor data in chunks
app.post('/api/sensor-data', (req, res) => {
  const { device_id, data, chunk, total_chunks } = req.body;
  
  if (!device_id || !data || !Array.isArray(data)) {
    console.log('Invalid data format received');
    return res.status(400).send('Invalid data format');
  }
  
  // Always create a new file for the first chunk of each upload session
  if (chunk === 0 || chunk === undefined) {
    // Generate a unique filename with timestamp
    const currentTime = new Date();
    const dateStr = currentTime.toISOString().split('T')[0];
    const timeStr = currentTime.toISOString().split('T')[1].replace(/:/g, '-').split('.')[0];
    const sessionId = Date.now().toString(); // Unique session ID
    const filename = `${device_id}_${dateStr}_${timeStr}_${sessionId}.csv`;
    const filepath = path.join(dataDir, filename);
    
    console.log(`Creating new file for upload session: ${filename}`);
    
    // Initialize tracking for this upload
    activeUploads[device_id] = {
      sessionId: sessionId,
      filename: filename,
      filepath: filepath,
      total_chunks: total_chunks || 1,
      received_chunks: 0,
      lastUpdate: Date.now()
    };
    
    // Create new file with headers - just IR value column
    fs.writeFileSync(filepath, 'ir_value\n');
  }
  
  // If no active upload exists for this device (might have missed chunk 0), create one
  if (!activeUploads[device_id]) {
    const currentTime = new Date();
    const dateStr = currentTime.toISOString().split('T')[0];
    const timeStr = currentTime.toISOString().split('T')[1].replace(/:/g, '-').split('.')[0];
    const sessionId = Date.now().toString();
    const filename = `${device_id}_recovery_${dateStr}_${timeStr}_${sessionId}.csv`;
    const filepath = path.join(dataDir, filename);
    
    console.log(`Creating recovery file for ongoing upload: ${filename}`);
    
    activeUploads[device_id] = {
      sessionId: sessionId,
      filename: filename,
      filepath: filepath,
      total_chunks: total_chunks || 1,
      received_chunks: 0,
      lastUpdate: Date.now()
    };
    
    fs.writeFileSync(filepath, 'ir_value\n');
  }
  
  // Update tracking information
  activeUploads[device_id].received_chunks++;
  activeUploads[device_id].lastUpdate = Date.now();
  
  // For logging
  if (chunk !== undefined) {
    console.log(`Received chunk ${chunk + 1} of ${total_chunks} from ${device_id} with ${data.length} samples`);
  } else {
    console.log(`Received complete data from ${device_id} with ${data.length} samples`);
  }
  
  try {
    // Append data to the file - just IR values, one per line
    let csvData = '';
    data.forEach((value) => {
      csvData += value + '\n';
    });
    
    fs.appendFileSync(activeUploads[device_id].filepath, csvData);
    
    // Process heart rate for this chunk using improved algorithm
    const hrInfo = processHeartRate(data);
    
    // Update real-time data with latest values
    broadcastData(data, hrInfo);
    
    // Check if all chunks have been received
    if (chunk === undefined || activeUploads[device_id].received_chunks >= activeUploads[device_id].total_chunks) {
      console.log(`All data received for ${device_id}`);
      console.log(`Complete data saved to ${activeUploads[device_id].filepath}`);
      
      // Clean up the tracker
      delete activeUploads[device_id];
    }
    
    res.status(200).send('Data received successfully');
  } catch (err) {
    console.error('Error saving data:', err);
    res.status(500).send('Server error saving data');
  }
});

// Endpoint to list available data files
app.get('/api/data-files', (req, res) => {
  fs.readdir(dataDir, (err, files) => {
    if (err) {
      console.error('Error reading data directory:', err);
      return res.status(500).send('Error reading data directory');
    }
    
    // Sort files by modification time (newest first)
    const filesWithStats = files.map(filename => {
      const filepath = path.join(dataDir, filename);
      const stats = fs.statSync(filepath);
      return { 
        filename: filename,
        mtime: stats.mtime
      };
    });
    
    filesWithStats.sort((a, b) => b.mtime - a.mtime);
    
    // Return just the filenames
    res.json(filesWithStats.map(file => file.filename));
  });
});

// Endpoint to retrieve a specific data file
app.get('/api/data-files/:filename', (req, res) => {
  const filename = req.params.filename;
  const filepath = path.join(dataDir, filename);
  
  if (!fs.existsSync(filepath)) {
    return res.status(404).send('File not found');
  }
  
  res.sendFile(filepath);
});

// Dashboard endpoint
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Cleanup inactive uploads - run every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, upload] of Object.entries(activeUploads)) {
    // If upload inactive for more than 10 minutes, clean it up
    if (now - upload.lastUpdate > 600000) {
      console.log(`Cleaning up inactive upload from ${deviceId}`);
      delete activeUploads[deviceId];
    }
  }
}, 300000);

// IMPORTANT: Bind to all interfaces (0.0.0.0)
server.listen(PORT, '0.0.0.0', () => {
  const ip = getIpAddress();
  console.log('Server running on port ' + PORT);
  console.log('Server IP address: ' + ip);
  console.log('Access the dashboard at http://' + ip + ':' + PORT + '/dashboard');
});