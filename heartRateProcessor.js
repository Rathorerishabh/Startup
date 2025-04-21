// Final Heart Rate Calculator
// Processes each batch of 500 samples with extended acquisition period

// Keep track of the last 4 shown heart rates for stability checking
const recentHeartRates = [];
const MAX_HISTORY = 4; // Keep last 4 heart rate readings for stability

// Track number of batches received for extended acquisition
let batchesReceived = 0;
const MIN_BATCHES_FOR_DISPLAY = 5; // Require at least 5 batches before showing heart rate

// Heart rate zones
const HR_ZONES = [
  { name: "Rest", color: "#3498db", upperLimit: 90, colorCode: "#3498db" },
  { name: "Light", color: "#2ecc71", upperLimit: 110, colorCode: "#2ecc71" },
  { name: "Moderate", color: "#f1c40f", upperLimit: 130, colorCode: "#f1c40f" },
  { name: "Vigorous", color: "#e67e22", upperLimit: 150, colorCode: "#e67e22" },
  { name: "High", color: "#e74c3c", upperLimit: 170, colorCode: "#e74c3c" },
  { name: "Maximum", color: "#9b59b6", upperLimit: 240, colorCode: "#9b59b6" }
];

// Track acquisition state
let isAcquiring = false;
let acquisitionStartTime = 0;
let isStable = false;

// Main heart rate processing function - processes only the current 500 samples
function processHeartRate(ppgData) {
  const currentTime = Date.now();
  
  // Check if we have enough data
  if (!ppgData || ppgData.length < 100) {
    isAcquiring = false;
    batchesReceived = 0;
    return createResponse(0, false, "No signal", "Place finger on sensor");
  }

  // Calculate basic signal metrics
  const min = Math.min(...ppgData);
  const max = Math.max(...ppgData);
  
  // STRICT finger detection based exactly on IR values being above 18000
  const fingerDetected = max > 18000;
  
  if (!fingerDetected) {
    isAcquiring = false;
    batchesReceived = 0;
    return createResponse(0, false, "No signal", "Place finger on sensor");
  }
  
  // Start acquisition process if not already acquiring
  if (!isAcquiring) {
    isAcquiring = true;
    acquisitionStartTime = currentTime;
    isStable = false;
    batchesReceived = 0;
  }
  
  // Increment batch counter when finger is detected
  batchesReceived++;
  
  // Calculate heart rate directly from the 500 samples
  
  // STEP 1: Basic signal filtering on the current batch
  const filteredSignal = filterSignal(ppgData);
  
  // STEP 2: Detect peaks in the filtered signal
  const peaks = detectPeaks(filteredSignal);
  
  // STEP 3: Calculate heart rate directly from peaks in this batch
  let heartRate = 0;
  
  if (peaks.length >= 2) {
    // METHOD 1: Calculate from intervals between peaks
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push(peaks[i] - peaks[i-1]);
    }
    
    // Filter out physiologically impossible intervals
    const validIntervals = intervals.filter(interval => {
      // Assuming 150Hz sample rate:
      // 30 BPM = 150 * 60/30 = 300 samples between peaks
      // 240 BPM = 150 * 60/240 = 37.5 samples between peaks
      return interval >= 37 && interval <= 300;
    });
    
    if (validIntervals.length > 0) {
      // Calculate average interval
      const avgInterval = validIntervals.reduce((sum, val) => sum + val, 0) / validIntervals.length;
      
      // Convert to heart rate (BPM) assuming 150Hz sample rate
      // BPM = 60 * sample_rate / samples_per_beat
      heartRate = Math.round(60 * 150 / avgInterval);
      
      // Validate result is physiologically plausible
      if (heartRate < 40 || heartRate > 200) {
        heartRate = 0;
      }
    }
    
    // METHOD 2: If method 1 failed, try direct peak counting
    if (heartRate === 0 && peaks.length >= 3) {
      // Calculate rate from number of peaks and time span
      // Using first and last peak to determine time span in samples
      const sampleSpan = peaks[peaks.length - 1] - peaks[0];
      // Convert to seconds assuming 150Hz
      const timeSpanSeconds = sampleSpan / 150;
      // Number of beats is (peaks - 1)
      const beatCount = peaks.length - 1;
      // BPM = beats * 60 / time_span_seconds
      heartRate = Math.round(beatCount * 60 / timeSpanSeconds);
      
      // Validate result
      if (heartRate < 40 || heartRate > 200) {
        heartRate = 0;
      }
    }
    
    // METHOD 3: If the above methods failed, try from total data duration
    if (heartRate === 0 && peaks.length >= 2) {
      // Calculate from total sample duration
      // 500 samples at 150Hz = 3.33 seconds
      const durationSeconds = ppgData.length / 150;
      // BPM = beats * 60 / duration
      heartRate = Math.round((peaks.length - 1) * 60 / durationSeconds);
      
      // Validate result
      if (heartRate < 40 || heartRate > 200) {
        heartRate = 0;
      }
    }
  }
  
  // If we got a valid heart rate, add it to history
  if (heartRate > 0) {
    recentHeartRates.unshift(heartRate);
    if (recentHeartRates.length > MAX_HISTORY) {
      recentHeartRates.pop();
    }
  }
  
  // Check if the last 3-4 heart rates are within ±15 BPM
  let finalHeartRate = heartRate;
  
  if (recentHeartRates.length >= 3) {
    let inRange = true;
    
    // Check if all values are within ±15 BPM of each other
    for (let i = 0; i < Math.min(4, recentHeartRates.length); i++) {
      for (let j = i + 1; j < Math.min(4, recentHeartRates.length); j++) {
        if (Math.abs(recentHeartRates[i] - recentHeartRates[j]) > 15) {
          inRange = false;
          break;
        }
      }
      if (!inRange) break;
    }
    
    if (!inRange) {
      // If not in range, take the mean of the last 3-4 values
      const valuesToAverage = recentHeartRates.slice(0, Math.min(4, recentHeartRates.length));
      finalHeartRate = Math.round(valuesToAverage.reduce((sum, val) => sum + val, 0) / valuesToAverage.length);
    } else {
      // If they are in range, use the current reading
      finalHeartRate = heartRate > 0 ? heartRate : recentHeartRates[0];
    }
  }
  
  // Check if reading is stable (all recent readings within ±15 BPM)
  isStable = recentHeartRates.length >= 3;
  
  if (isStable) {
    // Check max difference between any two readings
    for (let i = 0; i < Math.min(4, recentHeartRates.length); i++) {
      for (let j = i + 1; j < Math.min(4, recentHeartRates.length); j++) {
        if (Math.abs(recentHeartRates[i] - recentHeartRates[j]) > 15) {
          isStable = false;
          break;
        }
      }
      if (!isStable) break;
    }
  }
  
  // Determine heart rate zone
  let zone = HR_ZONES[0]; // Default to Rest
  if (finalHeartRate > 0) {
    for (let i = 0; i < HR_ZONES.length; i++) {
      if (finalHeartRate <= HR_ZONES[i].upperLimit) {
        zone = HR_ZONES[i];
        break;
      }
    }
  }
  
  // Determine display text and details
  let displayText = "No signal";
  let detailText = "Acquiring...";
  const acquisitionTime = currentTime - acquisitionStartTime;
  const acquisitionSecondsElapsed = Math.floor(acquisitionTime / 1000);
  
  // NEW CHANGE: Check for minimum acquisition time/batches before showing heart rate
  const inAcquisitionPhase = batchesReceived < MIN_BATCHES_FOR_DISPLAY;
  
  if (finalHeartRate > 0) {
    if (inAcquisitionPhase) {
      // Show acquisition message for the first 4-5 batches
      displayText = "Acquiring signal";
      detailText = `Please wait... (${acquisitionSecondsElapsed}s)`;
    } else if (isStable) {
      // Stable heart rate after acquisition period
      displayText = `${finalHeartRate}`;
      detailText = zone.name;
    } else {
      // Have heart rate but not yet stable
      displayText = `${finalHeartRate}`;
      detailText = "Stabilizing...";
    }
  } else {
    // No valid heart rate yet
    if (acquisitionTime < 2000) {
      displayText = "Detecting pulse";
      detailText = "Please wait...";
    } else {
      displayText = "Acquiring signal";
      detailText = `Keep finger still (${acquisitionSecondsElapsed}s)`;
    }
  }
  
  // Create response object
  return createResponse(
    inAcquisitionPhase ? 0 : finalHeartRate, // Don't send heart rate during acquisition phase
    fingerDetected,
    displayText,
    detailText,
    zone.name,
    zone.colorCode,
    "stable", // No trend calculation needed
    {
      signalMax: max,
      peakCount: peaks.length,
      batchSize: ppgData.length,
      calculatedRate: heartRate,
      finalRate: finalHeartRate,
      recentRates: recentHeartRates.slice(0, 4),
      stable: isStable,
      batchesReceived: batchesReceived,
      inAcquisitionPhase: inAcquisitionPhase
    }
  );
}

// Filter signal to remove noise and emphasize heart beats
function filterSignal(ppgData) {
  // STEP 1: Normalize the signal (remove DC component)
  const mean = ppgData.reduce((sum, val) => sum + val, 0) / ppgData.length;
  const normalized = ppgData.map(val => val - mean);
  
  // STEP 2: Apply simple moving average to smooth the signal
  const windowSize = 5;
  const smoothed = [];
  
  for (let i = 0; i < normalized.length; i++) {
    let sum = 0;
    let count = 0;
    
    for (let j = Math.max(0, i - windowSize); j <= Math.min(normalized.length - 1, i + windowSize); j++) {
      sum += normalized[j];
      count++;
    }
    
    smoothed.push(sum / count);
  }
  
  // STEP 3: Apply basic derivative to emphasize slopes
  const derivative = [];
  for (let i = 1; i < smoothed.length; i++) {
    derivative.push(smoothed[i] - smoothed[i-1]);
  }
  derivative.unshift(0); // Add a zero at the beginning to maintain array length
  
  // STEP 4: Square the signal to amplify peaks and make everything positive
  const squared = derivative.map(val => val * val);
  
  // STEP 5: Another round of smoothing to clean up the signal
  const result = [];
  const finalWindowSize = 8;
  
  for (let i = 0; i < squared.length; i++) {
    let sum = 0;
    let count = 0;
    
    for (let j = Math.max(0, i - finalWindowSize); j <= Math.min(squared.length - 1, i + finalWindowSize); j++) {
      sum += squared[j];
      count++;
    }
    
    result.push(sum / count);
  }
  
  return result;
}

// Detect peaks in the filtered signal
function detectPeaks(filteredSignal) {
  const peaks = [];
  
  // Calculate an adaptive threshold
  const sortedSignal = [...filteredSignal].sort((a, b) => b - a);
  // Use the top 25% percentile as a base for threshold
  const thresholdBase = sortedSignal[Math.floor(sortedSignal.length * 0.25)];
  const threshold = thresholdBase * 0.5; // 50% of the top 25% value
  
  // Minimum distance between peaks (in samples) - assuming 150Hz sample rate
  // This corresponds to 240 BPM max (60 * 150 / 240 = 37.5 samples)
  const minPeakDistance = 38;
  
  // Find peaks
  let lastPeakIndex = -minPeakDistance;
  
  for (let i = 2; i < filteredSignal.length - 2; i++) {
    // Check if this point is a local maximum
    if (filteredSignal[i] > filteredSignal[i-1] &&
        filteredSignal[i] > filteredSignal[i-2] &&
        filteredSignal[i] > filteredSignal[i+1] &&
        filteredSignal[i] > filteredSignal[i+2] &&
        filteredSignal[i] > threshold &&
        (i - lastPeakIndex) >= minPeakDistance) {
      
      peaks.push(i);
      lastPeakIndex = i;
    }
  }
  
  // If we found too few peaks, try with a lower threshold
  if (peaks.length < 2 && thresholdBase > 0) {
    const lowerThreshold = thresholdBase * 0.2; // 20% of the top 25% value
    
    for (let i = 2; i < filteredSignal.length - 2; i++) {
      // Skip if we already identified this as a peak
      if (peaks.includes(i)) continue;
      
      // Check with lower threshold
      if (filteredSignal[i] > filteredSignal[i-1] &&
          filteredSignal[i] > filteredSignal[i-2] &&
          filteredSignal[i] > filteredSignal[i+1] &&
          filteredSignal[i] > filteredSignal[i+2] &&
          filteredSignal[i] > lowerThreshold &&
          (i - lastPeakIndex) >= minPeakDistance) {
        
        peaks.push(i);
        lastPeakIndex = i;
      }
    }
    
    // Sort peaks by index
    peaks.sort((a, b) => a - b);
  }
  
  return peaks;
}

// Create a standardized response object
function createResponse(heartRate, fingerDetected, displayValue, displayDetails, zoneName = "Rest", zoneColor = "#3498db", trend = "stable", debug = {}) {
  return {
    heartRate: heartRate,
    fingerDetected: fingerDetected,
    display_value: displayValue,
    display_details: displayDetails,
    zone: zoneName,
    zoneColor: zoneColor,
    quality: fingerDetected ? 0.8 : 0,  // Simple quality metric
    confidence: fingerDetected ? 0.8 : 0, // Simple confidence metric
    trend: trend,
    phase: fingerDetected ? (batchesReceived < MIN_BATCHES_FOR_DISPLAY ? "acquiring" : (isStable ? "tracking" : "stabilizing")) : "no_signal",
    debug: debug
  };
}

// Export the function for use in the server
module.exports = { processHeartRate };