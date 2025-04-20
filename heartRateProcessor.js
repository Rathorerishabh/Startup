// Advanced Heart Rate Processing Module with stability enhancements

// Constants for heart rate detection
const HR_CONSTANTS = {
    SAMPLE_RATE: 150,              // Expected sample rate in Hz
    MIN_HR: 40,                    // Minimum physiological heart rate
    MAX_HR: 200,                   // Maximum physiological heart rate
    BUFFER_SIZE: 1000,             // Size of buffer for calculations
    MIN_PEAKS: 3,                  // Minimum peaks needed for calculation
    SIGNAL_THRESHOLD: 2000,        // Threshold for finger detection
    QUALITY_LEVELS: 5,             // Number of quality levels
    MAX_JUMP: 15                   // Maximum allowed BPM change between readings
  };
  
  // Heart rate state tracking
  let hrState = {
    fingerDetected: false,
    ppgBuffer: [],
    heartRateHistory: [],
    confidenceScores: [],
    timestamps: [],
    lastHeartRate: 0,
    lastCalculation: 0,
    signalQuality: 0,
    stabilityCounter: 0,
    smoothedHeartRate: 0           // Smoothed heart rate for display
  };
  
  // Process heart rate with enhanced stability
  function processHeartRate(ppgData) {
    // Add incoming data to buffer
    hrState.ppgBuffer = hrState.ppgBuffer.concat(ppgData);
    
    // Keep buffer at maximum size
    if (hrState.ppgBuffer.length > HR_CONSTANTS.BUFFER_SIZE) {
      hrState.ppgBuffer = hrState.ppgBuffer.slice(-HR_CONSTANTS.BUFFER_SIZE);
    }
    
    // Need enough data for meaningful analysis
    if (hrState.ppgBuffer.length < HR_CONSTANTS.SAMPLE_RATE * 2) {
      return { 
        heartRate: 0, 
        zone: "Rest", 
        quality: 0, 
        trend: "stable",
        fingerDetected: false 
      };
    }
    
    // Check for finger presence using signal quality
    const signalQuality = assessSignalQuality(hrState.ppgBuffer);
    hrState.fingerDetected = signalQuality > 0.3;
    
    if (!hrState.fingerDetected) {
      // Reset state if no finger detected
      hrState.stabilityCounter = 0;
      hrState.smoothedHeartRate = 0;
      return { 
        heartRate: 0, 
        zone: "Rest", 
        quality: 0, 
        trend: "stable",
        fingerDetected: false 
      };
    }
    
    // Only recalculate heart rate every 500ms to avoid unnecessary processing
    const now = Date.now();
    if (now - hrState.lastCalculation < 500 && hrState.smoothedHeartRate > 0) {
      // Return last calculation
      return {
        heartRate: hrState.smoothedHeartRate,
        zone: getCurrentZone(hrState.smoothedHeartRate),
        quality: hrState.signalQuality,
        trend: calculateTrend(hrState.heartRateHistory),
        fingerDetected: true
      };
    }
    
    // Main heart rate calculation process
    const result = calculateHeartRate(hrState.ppgBuffer);
    hrState.lastCalculation = now;
    
    if (result.heartRate > 0) {
      // Apply jump limitation - prevent physiologically impossible jumps
      let limitedHeartRate = result.heartRate;
      
      if (hrState.lastHeartRate > 0) {
        // Calculate maximum allowed change
        const maxChange = HR_CONSTANTS.MAX_JUMP;
        
        // Limit heart rate change
        if (Math.abs(result.heartRate - hrState.lastHeartRate) > maxChange) {
          // Move toward the new value, but limit the change
          if (result.heartRate > hrState.lastHeartRate) {
            limitedHeartRate = hrState.lastHeartRate + maxChange;
          } else {
            limitedHeartRate = hrState.lastHeartRate - maxChange;
          }
          
          // Adjust confidence based on jump limitation
          result.confidence *= 0.7; // Reduced confidence when jump limiting is applied
        }
      }
      
      // Store rate in history (after jump limiting)
      hrState.heartRateHistory.unshift(limitedHeartRate);
      hrState.confidenceScores.unshift(result.confidence);
      hrState.timestamps.unshift(now);
      
      // Limit history size
      if (hrState.heartRateHistory.length > 10) {
        hrState.heartRateHistory.pop();
        hrState.confidenceScores.pop();
        hrState.timestamps.pop();
      }
      
      // Store last raw heart rate (after jump limiting)
      hrState.lastHeartRate = limitedHeartRate;
      
      // Apply aggressive smoothing for display
      // Start with smoothed value or use limited rate if it's our first reading
      if (hrState.smoothedHeartRate === 0) {
        hrState.smoothedHeartRate = limitedHeartRate;
      } else {
        // Apply very strong smoothing to prevent jumps
        // More weight (85%) to previous value, only 15% to new reading
        hrState.smoothedHeartRate = Math.round(
          0.85 * hrState.smoothedHeartRate + 0.15 * limitedHeartRate
        );
      }
      
      hrState.signalQuality = result.confidence;
      
      // Check if readings are stable
      if (isStableReading(hrState.heartRateHistory)) {
        hrState.stabilityCounter++;
      } else {
        hrState.stabilityCounter = Math.max(0, hrState.stabilityCounter - 1);
      }
      
      return {
        heartRate: hrState.smoothedHeartRate,
        zone: getCurrentZone(hrState.smoothedHeartRate),
        quality: result.confidence,
        trend: calculateTrend(hrState.heartRateHistory),
        fingerDetected: true,
        isStable: hrState.stabilityCounter > 2
      };
    }
    
    // Fallback to last known heart rate if calculation failed but signal is good
    if (hrState.smoothedHeartRate > 0 && signalQuality > 0.5) {
      return {
        heartRate: hrState.smoothedHeartRate,
        zone: getCurrentZone(hrState.smoothedHeartRate),
        quality: signalQuality * 0.7, // Reduced confidence as this is a carried-over value
        trend: calculateTrend(hrState.heartRateHistory),
        fingerDetected: true
      };
    }
    
    // Default return if no valid heart rate detected
    return {
      heartRate: 0,
      zone: "Rest",
      quality: signalQuality,
      trend: "stable",
      fingerDetected: true
    };
  }
  
  // Calculate heart rate from PPG signal with improved peak detection
  function calculateHeartRate(ppgBuffer) {
    // 1. Pre-process signal
    const preprocessed = preprocessSignal(ppgBuffer);
    
    // 2. Detect peaks in processed signal
    const peakResult = detectPeaks(preprocessed);
    const peaks = peakResult.peaks;
    const peakQuality = peakResult.quality;
    
    // Need enough peaks for reliable heart rate calculation
    if (peaks.length < HR_CONSTANTS.MIN_PEAKS) {
      return { heartRate: 0, confidence: 0 };
    }
    
    // 3. Calculate intervals between peaks
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) {
      intervals.push((peaks[i] - peaks[i-1]) / HR_CONSTANTS.SAMPLE_RATE);
    }
    
    // 4. Filter out physiologically impossible intervals
    const validIntervals = intervals.filter(interval => 
      interval >= 60 / HR_CONSTANTS.MAX_HR && 
      interval <= 60 / HR_CONSTANTS.MIN_HR
    );
    
    if (validIntervals.length < 2) {
      return { heartRate: 0, confidence: 0 };
    }
    
    // 5. Advanced outlier rejection
    // First sort intervals
    validIntervals.sort((a, b) => a - b);
    
    // Calculate median and median absolute deviation (MAD) - robust to outliers
    const medianIndex = Math.floor(validIntervals.length / 2);
    const medianInterval = validIntervals[medianIndex];
    
    // Calculate MAD
    const absoluteDeviations = validIntervals.map(interval => Math.abs(interval - medianInterval));
    absoluteDeviations.sort((a, b) => a - b);
    const mad = absoluteDeviations[Math.floor(absoluteDeviations.length / 2)];
    
    // Filter intervals using MAD (more robust than standard deviation)
    const filteredIntervals = validIntervals.filter(interval => 
      Math.abs(interval - medianInterval) <= 2.5 * mad
    );
    
    if (filteredIntervals.length < 2) {
      return { heartRate: 0, confidence: 0 };
    }
    
    // 6. Calculate final heart rate using median of filtered intervals
    const finalMedianIndex = Math.floor(filteredIntervals.length / 2);
    const finalMedianInterval = filteredIntervals[finalMedianIndex];
    const heartRate = Math.round(60 / finalMedianInterval);
    
    // 7. Calculate confidence score
    const confidence = calculateConfidence(filteredIntervals, peakQuality);
    
    return { heartRate, confidence };
  }
  
  // Preprocess PPG signal with enhanced filtering
  function preprocessSignal(ppgBuffer) {
    // 1. Normalize signal (remove DC component)
    const mean = ppgBuffer.reduce((sum, val) => sum + val, 0) / ppgBuffer.length;
    const normalized = ppgBuffer.map(val => val - mean);
    
    // 2. Apply stronger bandpass filter (0.7Hz - 3.5Hz, typical heart rate frequencies)
    // Stronger filtering to reject noise
    const filtered = [];
    filtered[0] = normalized[0];
    filtered[1] = normalized[1];
    
    // Coefficients for bandpass ~0.7-3.5Hz at 150Hz (tighter than before)
    const a1 = -1.82;
    const a2 = 0.85;
    const b0 = 0.02;
    const b2 = -0.02;
    
    for (let i = 2; i < normalized.length; i++) {
      filtered[i] = b0 * normalized[i] + b2 * normalized[i-2] - a1 * filtered[i-1] - a2 * filtered[i-2];
    }
    
    // 3. Apply derivative filter to emphasize slopes
    const derivative = new Array(filtered.length).fill(0);
    for (let i = 2; i < filtered.length - 2; i++) {
      derivative[i] = (filtered[i+1] - filtered[i-1]) / 2;
    }
    
    // 4. Square the signal to emphasize peaks and make all values positive
    const squared = derivative.map(val => val * val);
    
    // 5. Apply moving average integration with wider window for stability
    const windowSize = Math.round(HR_CONSTANTS.SAMPLE_RATE * 0.15); // ~150ms window (wider)
    const integrated = new Array(squared.length).fill(0);
    
    // Optimized moving average calculation
    let sum = 0;
    for (let i = 0; i < windowSize && i < squared.length; i++) {
      sum += squared[i];
      integrated[i] = sum / (i + 1);
    }
    
    for (let i = windowSize; i < squared.length; i++) {
      sum = sum - squared[i - windowSize] + squared[i];
      integrated[i] = sum / windowSize;
    }
    
    return integrated;
  }
  
  // Enhanced peak detection focusing on consistency
  function detectPeaks(processedSignal) {
    // Find max value for adaptive thresholding
    let maxValue = 0;
    for (let i = 0; i < processedSignal.length; i++) {
      if (processedSignal[i] > maxValue) maxValue = processedSignal[i];
    }
    
    // Adaptive thresholds - primary and secondary
    const threshold1 = maxValue * 0.35;
    const threshold2 = maxValue * 0.15;
    
    // Parameters for peak detection
    const lookAhead = Math.floor(HR_CONSTANTS.SAMPLE_RATE * 0.05); // 50ms
    const minPeakDistance = Math.floor(HR_CONSTANTS.SAMPLE_RATE * 0.3); // 300ms (200bpm)
    
    // Find peaks
    const peaks = [];
    let lastPeakIndex = -minPeakDistance;
    
    for (let i = lookAhead; i < processedSignal.length - lookAhead; i++) {
      // Check if this is a local maximum
      let isPeak = true;
      for (let j = 1; j <= lookAhead; j++) {
        if (processedSignal[i] <= processedSignal[i-j] || 
            processedSignal[i] <= processedSignal[i+j]) {
          isPeak = false;
          break;
        }
      }
      
      // Add peak if it meets all criteria
      if (isPeak && processedSignal[i] > threshold1 && 
          (i - lastPeakIndex) >= minPeakDistance) {
        peaks.push(i);
        lastPeakIndex = i;
      }
    }
    
    // Calculate signal quality based on noise ratio
    let noiseCount = 0;
    const totalPoints = processedSignal.length - 2 * lookAhead;
    
    for (let i = lookAhead; i < processedSignal.length - lookAhead; i++) {
      if (processedSignal[i] > threshold2 && processedSignal[i] <= threshold1) {
        noiseCount++;
      }
    }
    
    const noiseRatio = noiseCount / totalPoints;
    let signalQuality = 1.0;
    
    if (noiseRatio > 0.4) signalQuality = 0.1;
    else if (noiseRatio > 0.3) signalQuality = 0.3;
    else if (noiseRatio > 0.2) signalQuality = 0.6;
    else if (noiseRatio > 0.1) signalQuality = 0.8;
    
    return { peaks, quality: signalQuality };
  }
  
  // Rest of the functions remain the same as in the previous code
  // calculateConfidence, applyTemporalSmoothing, isStableReading, calculateTrend, assessSignalQuality, getCurrentZone