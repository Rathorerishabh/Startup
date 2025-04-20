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

// Heart Rate Processing Implementation
const HR_ZONES = [
  { name: "Rest", color: "#3498db", upperLimit: 90, colorCode: "#3498db" },
  { name: "Light", color: "#2ecc71", upperLimit: 110, colorCode: "#2ecc71" },
  { name: "Moderate", color: "#f1c40f", upperLimit: 130, colorCode: "#f1c40f" },
  { name: "Vigorous", color: "#e67e22", upperLimit: 150, colorCode: "#e67e22" },
  { name: "High", color: "#e74c3c", upperLimit: 170, colorCode: "#e74c3c" },
  { name: "Maximum", color: "#9b59b6", upperLimit: 240, colorCode: "#9b59b6" }
];

// Heart rate processing state
let hrState = {
  fingerDetected: false,
  heartRate: 0,
  confidence: 0,
  quality: 0,
  heartRateHistory: [],
  timestamps: [],
  peaks: [],
  previousTimestamp: 0,
  ppgBuffer: []
};

// Track active uploads
const activeUploads = {};

// Latest received data for real-time view
const realtimeData = {
  lastUpdated: Date.now(),
  values: Array(500).fill(0),
  heartRate: 0,
  heartRateZone: "Rest",
  heartRateQuality: 0,
  heartRateTrend: "stable"
};

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
    fingerDetected: hrState.fingerDetected
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
        fingerDetected: hrState.fingerDetected
      }));
    }
  });
}

// Simple heart rate detection from PPG data
function processHeartRate(ppgData) {
  // Check if we have enough data
  if (!ppgData || ppgData.length < 100) {
    return { 
      heartRate: 0, 
      zone: "Rest", 
      quality: 0, 
      trend: "stable",
      fingerDetected: false 
    };
  }
  
  // Detect if finger is present based on signal amplitude
  const min = Math.min(...ppgData);
  const max = Math.max(...ppgData);
  const range = max - min;
  
  // Simple finger detection
  const fingerDetected = range > 1000;
  hrState.fingerDetected = fingerDetected;
  
  if (!fingerDetected) {
    return { 
      heartRate: 0, 
      zone: "Rest", 
      quality: 0, 
      trend: "stable",
      fingerDetected: false 
    };
  }
  
  // Add data to the buffer
  hrState.ppgBuffer = hrState.ppgBuffer.concat(ppgData);
  
  // Keep buffer at a reasonable size
  if (hrState.ppgBuffer.length > 1000) {
    hrState.ppgBuffer = hrState.ppgBuffer.slice(-1000);
  }
  
  // Normalize data
  const data = [...hrState.ppgBuffer];
  const mean = data.reduce((sum, val) => sum + val, 0) / data.length;
  const normalized = data.map(val => val - mean);
  
  // Simple peak detection
  const peaks = [];
  const minPeakDistance = 25; // minimum samples between peaks (~5 at 150Hz)
  const threshold = 0.5 * Math.max(...normalized.map(v => Math.abs(v)));
  
  for (let i = 2; i < normalized.length - 2; i++) {
    if (normalized[i] > threshold && 
        normalized[i] > normalized[i-1] && 
        normalized[i] > normalized[i-2] &&
        normalized[i] > normalized[i+1] && 
        normalized[i] > normalized[i+2]) {
      
      // Only add if far enough from previous peak
      if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minPeakDistance) {
        peaks.push(i);
      }
    }
  }
  
  // Calculate heart rate from peaks
  if (peaks.length >= 2) {
    // Calculate intervals
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push(peaks[i] - peaks[i-1]);
    }
    
    // Convert to heart rate (assuming 150Hz sample rate)
    const avgInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
    const heartRateBPM = Math.round(60 * 150 / avgInterval);
    
    // Check if heart rate is physiologically possible
    if (heartRateBPM >= 40 && heartRateBPM <= 200) {
      hrState.heartRate = heartRateBPM;
      
      // Store in history
      hrState.heartRateHistory.push(heartRateBPM);
      hrState.timestamps.push(Date.now());
      
      // Keep history at reasonable size
      if (hrState.heartRateHistory.length > 10) {
        hrState.heartRateHistory.shift();
        hrState.timestamps.shift();
      }
      
      // Calculate trend
      let trend = "stable";
      if (hrState.heartRateHistory.length >= 3) {
        const newest = hrState.heartRateHistory[hrState.heartRateHistory.length - 1];
        const oldest = hrState.heartRateHistory[0];
        const diff = newest - oldest;
        
        if (diff > 5) trend = "rising";
        else if (diff < -5) trend = "falling";
      }
      
      // Calculate quality (0-1)
      const intervalVariance = calculateVariance(intervals);
      const quality = Math.max(0, Math.min(1, 1 - (intervalVariance / 150)));
      
      // Determine zone
      let zone = HR_ZONES[0];
      for (let i = 0; i < HR_ZONES.length; i++) {
        if (heartRateBPM <= HR_ZONES[i].upperLimit) {
            zone = HR_ZONES[i];
            break;
          }
        }
        
        return {
          heartRate: heartRateBPM,
          zone: zone.name,
          quality: quality,
          trend: trend,
          fingerDetected: true
        };
      }
    }
    
    // Default return if no valid heart rate detected
    return {
      heartRate: 0,
      zone: "Rest",
      quality: 0,
      trend: "stable",
      fingerDetected: fingerDetected
    };
  }
  
  // Helper function to calculate variance
  function calculateVariance(array) {
    const mean = array.reduce((sum, val) => sum + val, 0) / array.length;
    return array.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / array.length;
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
    
    // Process heart rate from PPG data
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
      
      // Process heart rate for this chunk too
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