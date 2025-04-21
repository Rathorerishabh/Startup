// Final Heart Rate Calculator with Complete Protection
// Maintains all previous rules while preventing unrealistic readings

// Keep track of the last 4 shown heart rates for stability checking
const recentHeartRates = [];
const MAX_HISTORY = 4; // Keep last 4 heart rate readings for stability

// Buffer to hold 1000 samples (two batches)
let sampleBuffer = [];
const MAX_BUFFER_SIZE = 1000;

// Track number of batches received for extended acquisition
let batchesReceived = 0;
const MIN_BATCHES_FOR_DISPLAY = 5; // Require at least 5 batches before showing heart rate

// Track finger detection state
let fingerDetectedState = false;
let lastDisplayedValue = "No signal";
let lastDisplayedHeartRate = 0;
let consecutiveLowSignalBatches = 0;

// Track high zone readings
let consecutiveHighZoneReadings = 0;
const MIN_HIGH_ZONE_STREAK = 5; // Require 5 consecutive high readings to confirm (increased from 3)

// Heart rate zones
const HR_ZONES = [
  { name: "Rest", color: "#3498db", upperLimit: 90, colorCode: "#3498db" },
  { name: "Light", color: "#2ecc71", upperLimit: 110, colorCode: "#2ecc71" },
  { name: "Moderate", color: "#f1c40f", upperLimit: 130, colorCode: "#f1c40f" },
  { name: "Vigorous", color: "#e67e22", upperLimit: 150, colorCode: "#e67e22" },
  { name: "High", color: "#e74c3c", upperLimit: 170, colorCode: "#e74c3c" },
  { name: "Maximum", color: "#9b59b6", upperLimit: 240, colorCode: "#9b59b6" }
];

// Define thresholds for what qualifies as "high heart rate"
const VIGOROUS_THRESHOLD = 130; // Readings above this are considered "high"

// Track acquisition state
let isAcquiring = false;
let acquisitionStartTime = 0;
let isStable = false;

// Track first display time for initial period bias
let firstDisplayTime = 0;
const INITIAL_PERIOD_DURATION = 30000; // 30 seconds of extra caution for high readings

// Reset all state variables
function resetState() {
  isAcquiring = false;
  batchesReceived = 0;
  sampleBuffer = [];
  consecutiveLowSignalBatches = 0;
  fingerDetectedState = false;
  isStable = false;
  consecutiveHighZoneReadings = 0;
  firstDisplayTime = 0;
  lastDisplayedHeartRate = 0;
}

// Main heart rate processing function
function processHeartRate(ppgData) {
  const currentTime = Date.now();
  
  // Check if we have enough data
  if (!ppgData || ppgData.length < 100) {
    return createResponse(0, false, "No signal", "Place finger on sensor");
  }

  // Calculate basic signal metrics
  const min = Math.min(...ppgData);
  const max = Math.max(...ppgData);
  
  // FINGER DETECTION:
  // Count how many samples are below the threshold
  const belowThresholdCount = ppgData.filter(val => val <= 18000).length;
  const percentBelowThreshold = (belowThresholdCount / ppgData.length) * 100;
  
  // Only consider finger removed if 70% or more of samples are below threshold
  const currentBatchHasFinger = percentBelowThreshold < 70;
  
  // Track consecutive batches with low signal
  if (!currentBatchHasFinger) {
    consecutiveLowSignalBatches++;
  } else {
    consecutiveLowSignalBatches = 0;
  }
  
  // FINGER STATE LOGIC:
  // 1. If current batch has finger, set state to true
  // 2. Only set state to false if we've had multiple consecutive batches with low signal
  if (currentBatchHasFinger) {
    fingerDetectedState = true;
  } else if (consecutiveLowSignalBatches >= 2) {
    // Only reset after 2 consecutive batches with low signal
    fingerDetectedState = false;
  }
  
  // Handle acquisition state based on finger detection
  if (fingerDetectedState) {
    // Start acquisition process if not already acquiring
    if (!isAcquiring) {
      isAcquiring = true;
      acquisitionStartTime = currentTime;
      isStable = false;
      batchesReceived = 0;
      sampleBuffer = []; // Clear buffer
      consecutiveHighZoneReadings = 0; // Reset high zone streak counter
      firstDisplayTime = 0; // Reset first display time
    }
    
    // Only increment batch counter and add to buffer if current batch has good signal
    if (currentBatchHasFinger) {
      batchesReceived++;
      
      // Add current batch to sample buffer
      sampleBuffer = sampleBuffer.concat(ppgData);
      
      // Keep buffer at maximum size (1000 samples)
      if (sampleBuffer.length > MAX_BUFFER_SIZE) {
        sampleBuffer = sampleBuffer.slice(-MAX_BUFFER_SIZE);
      }
    }
  } else {
    // Finger definitely removed - reset state
    resetState();
    return createResponse(0, false, "No signal", "Place finger on sensor");
  }
  
  // Wait until we have at least 750 samples for calculation (should happen by batch 2)
  let heartRate = 0;
  let peaks = [];
  
  if (sampleBuffer.length >= 750) {
    // STEP 1: Basic signal filtering on the 1000-sample window
    const filteredSignal = filterSignal(sampleBuffer);
    
    // STEP 2: Detect peaks in the filtered signal
    peaks = detectPeaks(filteredSignal);
    
    // STEP 3: Calculate heart rate directly from peaks in the 1000-sample window
    if (peaks.length >= 3) { // Need at least 3 peaks for reliable calculation
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
      if (heartRate === 0 && peaks.length >= 4) {
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
      if (heartRate === 0 && peaks.length >= 3) {
        // Calculate from total sample duration
        // 1000 samples at 150Hz = 6.67 seconds
        const durationSeconds = sampleBuffer.length / 150;
        // BPM = beats * 60 / duration
        heartRate = Math.round((peaks.length - 1) * 60 / durationSeconds);
        
        // Validate result
        if (heartRate < 40 || heartRate > 200) {
          heartRate = 0;
        }
      }
    }
  }
  
  // Apply initial correction to reduce unrealistically high readings
  // First 10 batches after acquisition have a corrective factor applied
  if (heartRate > 0) {
    // Initial reading correction - stronger for higher heart rates
    if (batchesReceived <= MIN_BATCHES_FOR_DISPLAY + 5) {
      // Apply a more aggressive correction factor for initial readings
      let correctionFactor = 0;
      
      // Higher correction for higher heart rates
      if (heartRate >= VIGOROUS_THRESHOLD) {
        // Apply up to 15% reduction for high initial readings
        correctionFactor = Math.max(0, 1 - (batchesReceived / 10));
        const correctionAmount = Math.round(heartRate * 0.15 * correctionFactor);
        heartRate = heartRate - correctionAmount;
      } else if (heartRate >= 110) {
        // Apply up to 10% reduction for moderate initial readings
        correctionFactor = Math.max(0, 1 - (batchesReceived / 10));
        const correctionAmount = Math.round(heartRate * 0.10 * correctionFactor);
        heartRate = heartRate - correctionAmount;
      } else {
        // Apply up to 5% reduction for low initial readings
        correctionFactor = Math.max(0, 1 - (batchesReceived / 10));
        const correctionAmount = Math.round(heartRate * 0.05 * correctionFactor);
        heartRate = heartRate - correctionAmount;
      }
    }
    
    // Track first time we display a heart rate
    if (firstDisplayTime === 0 && batchesReceived >= MIN_BATCHES_FOR_DISPLAY) {
      firstDisplayTime = currentTime;
    }
  }
  
  // If we got a valid heart rate, add it to history
  if (heartRate > 0) {
    recentHeartRates.unshift(heartRate);
    if (recentHeartRates.length > MAX_HISTORY) {
      recentHeartRates.pop();
    }
  }
  
  // Track high heart rate readings
  let highRateDetected = heartRate >= VIGOROUS_THRESHOLD;
  
  // Count consecutive high readings
  if (highRateDetected) {
    consecutiveHighZoneReadings++;
  } else {
    consecutiveHighZoneReadings = 0;
  }
  
  // Check if the last 3-4 heart rates are within ±15 BPM
  let finalHeartRate = heartRate;
  
  if (recentHeartRates.length >= 3) {
    let inRange = true;
    
    // Check if all values are within ±15 BPM of each other (MAINTAINING ORIGINAL RULE)
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
      // Special handling for high readings during initial period
      const isInInitialPeriod = firstDisplayTime > 0 && 
                               (currentTime - firstDisplayTime) < INITIAL_PERIOD_DURATION;
      
      if (highRateDetected && 
         (isInInitialPeriod || consecutiveHighZoneReadings < MIN_HIGH_ZONE_STREAK)) {
        // During initial period or without confirmed streak, be very skeptical of high readings
        
        // Get median of recent readings (more robust than mean)
        const sortedReadings = [...recentHeartRates].sort((a, b) => a - b);
        const medianReading = sortedReadings[Math.floor(sortedReadings.length / 2)];
        
        // If the median is also high, use a weighted average
        if (medianReading >= VIGOROUS_THRESHOLD) {
          // Even the median is high, but still be cautious
          const valuesToAverage = recentHeartRates.slice(0, Math.min(4, recentHeartRates.length));
          finalHeartRate = Math.round(valuesToAverage.reduce((sum, val) => sum + val, 0) / valuesToAverage.length);
        } else {
          // The median is not high, strongly favor lower readings
          finalHeartRate = Math.min(medianReading + 10, 
                                    Math.round(medianReading * 0.7 + heartRate * 0.3));
        }
      } else {
        // Regular case - take mean of all recent readings
        const valuesToAverage = recentHeartRates.slice(0, Math.min(4, recentHeartRates.length));
        finalHeartRate = Math.round(valuesToAverage.reduce((sum, val) => sum + val, 0) / valuesToAverage.length);
      }
    } else {
      // If readings are in range, use the current reading
      finalHeartRate = heartRate > 0 ? heartRate : recentHeartRates[0];
    }
  }
  
  // SEVERE RESTRICTION: Override vigorous readings during first minute 
  // unless there's overwhelming evidence
  if (finalHeartRate >= VIGOROUS_THRESHOLD) {
    const timeSinceFirstDisplay = firstDisplayTime > 0 ? currentTime - firstDisplayTime : 0;
    
    // In first 60 seconds, be extremely skeptical of vigorous readings
    if (timeSinceFirstDisplay < 60000) {
      // Need more consecutive confirmations early on
      const requiredStreak = Math.max(MIN_HIGH_ZONE_STREAK, 
                                    Math.round(5 + (60000 - timeSinceFirstDisplay) / 15000));
      
      if (consecutiveHighZoneReadings < requiredStreak) {
        // Not enough confirmation - cap at moderate zone
        finalHeartRate = Math.min(finalHeartRate, 125); // Cap just below vigorous
        
        // If there's a previous displayed heart rate, ensure smooth transition
        if (lastDisplayedHeartRate > 0 && lastDisplayedHeartRate < finalHeartRate) {
          // Limit increase to 5 BPM per reading in initial period
          finalHeartRate = Math.min(finalHeartRate, lastDisplayedHeartRate + 5);
        }
      }
    }
    // Otherwise for first 3 minutes, still be cautious
    else if (timeSinceFirstDisplay < 180000) {
      if (consecutiveHighZoneReadings < MIN_HIGH_ZONE_STREAK) {
        // Blended approach - allow some increase but still limit
        if (lastDisplayedHeartRate > 0 && lastDisplayedHeartRate < finalHeartRate) {
          // Allow up to 8 BPM increase per reading after first minute
          finalHeartRate = Math.min(finalHeartRate, lastDisplayedHeartRate + 8);
        }
      }
    }
  }
  
  // Check if reading is stable (all recent readings within ±15 BPM) - MAINTAINING ORIGINAL RULE
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
  
  // Save last displayed heart rate
  if (finalHeartRate > 0 && batchesReceived >= MIN_BATCHES_FOR_DISPLAY) {
    lastDisplayedHeartRate = finalHeartRate;
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
  
  // Check for minimum acquisition time/batches before showing heart rate
  const inAcquisitionPhase = batchesReceived < MIN_BATCHES_FOR_DISPLAY;
  
  if (finalHeartRate > 0) {
    if (inAcquisitionPhase) {
      // Show acquisition message for the first 5 batches
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
  
  // Save last displayed value
  lastDisplayedValue = displayText;
  
  // Create response object
  return createResponse(
    inAcquisitionPhase ? 0 : finalHeartRate, // Don't send heart rate during acquisition phase
    fingerDetectedState,
    displayText,
    detailText,
    zone.name,
    zone.colorCode,
    "stable", // No trend calculation needed
    {
      signalMax: max,
      bufferSize: sampleBuffer.length,
      peakCount: peaks ? peaks.length : 0,
      calculatedRate: heartRate,
      finalRate: finalHeartRate,
      recentRates: recentHeartRates.slice(0, 4),
      stable: isStable,
      batchesReceived: batchesReceived,
      inAcquisitionPhase: inAcquisitionPhase,
      percentBelowThreshold: percentBelowThreshold,
      consecutiveLowSignalBatches: consecutiveLowSignalBatches,
      isHighRate: finalHeartRate >= VIGOROUS_THRESHOLD,
      consecutiveHighZoneReadings: consecutiveHighZoneReadings,
      timeSinceFirstDisplay: firstDisplayTime > 0 ? currentTime - firstDisplayTime : 0
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
  if (peaks.length < 3 && thresholdBase > 0) {
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