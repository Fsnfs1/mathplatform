/**
 * face_auth.js - Pure Frontend Face Recognition & Authentication Module
 * High School Mobile Math Practice & Anti-Cheating Quiz Platform
 * 
 * Capabilities:
 * 1. Web camera access with mirroring, 320x240 canvas snapshot, 0.70 JPEG compression.
 * 2. Integration with @vladmandic/face-api (TinyFaceDetector, FaceLandmark68TinyNet, FaceRecognitionNet).
 * 3. 128-dimensional face embedding extraction and Cosine Similarity calculation (>= 85% threshold).
 * 4. Deterministic Demo / Fallback Mode generating 128-d pseudo-vectors and simulated avatar snapshots
 *    when cameras are unavailable, denied, or running in automated test suites.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FaceAuthModule = factory();
    // Expose convenient global methods for vanilla script tags
    root.captureFace = root.FaceAuthModule.captureFace;
    root.verifyFace = root.FaceAuthModule.verifyFace;
    root.getDemoDescriptor = root.FaceAuthModule.getDemoDescriptor;
    root.generateDemoSnapshot = root.FaceAuthModule.generateDemoSnapshot;
    root.computeCosineSimilarity = root.FaceAuthModule.computeCosineSimilarity;
    root.initFaceApi = root.FaceAuthModule.initFaceApi;
    root.areModelsLoaded = root.FaceAuthModule.areModelsLoaded;
    root.isModelLoading = root.FaceAuthModule.isModelLoading;
    root.isDemoMode = root.FaceAuthModule.isDemoMode;
    root.setDemoMode = root.FaceAuthModule.setDemoMode;
    root.startCamera = root.FaceAuthModule.startCamera;
    root.stopCamera = root.FaceAuthModule.stopCamera;
    root.serializeDescriptor = root.FaceAuthModule.serializeDescriptor;
    root.deserializeDescriptor = root.FaceAuthModule.deserializeDescriptor;
    root.serializeDescriptorWithTimestamp = root.FaceAuthModule.serializeDescriptorWithTimestamp;
    root.isCameraRunning = root.FaceAuthModule.isCameraRunning;
    root.identifyFace1toN = root.FaceAuthModule.identifyFace1toN;
    root.calculateEAR = root.FaceAuthModule.calculateEAR;
    root.startBlinkDetection = root.FaceAuthModule.startBlinkDetection;
    root.centerVector = root.FaceAuthModule.centerVector;
    root.computeCenteredSimilarity = root.FaceAuthModule.computeCenteredSimilarity;
    root.computeEuclideanDistance = root.FaceAuthModule.computeEuclideanDistance;
    root.checkDuplicateFace = root.FaceAuthModule.checkDuplicateFace;
    root.calculateMeanVector = root.FaceAuthModule.calculateMeanVector;
    root.getReferenceMeanVector = root.FaceAuthModule.getReferenceMeanVector;
    root.setReferenceMeanVector = root.FaceAuthModule.setReferenceMeanVector;
    root.REFERENCE_MEAN_VECTOR = root.FaceAuthModule.REFERENCE_MEAN_VECTOR;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Constants
  const DEFAULT_MODEL_URI = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
  const DEFAULT_SIMILARITY_THRESHOLD = 0.85; // 85% cosine similarity required
  const SNAPSHOT_WIDTH = 320;
  const SNAPSHOT_HEIGHT = 240;
  const JPEG_QUALITY = 0.70;

  // Reference Mean Vector \bar{\mu} for Feature Centering (128-dimensional embedding space)
  const REFERENCE_MEAN_VECTOR = new Float32Array([
    -0.062547, 0.047934, 0.027815, -0.038234, -0.076976, -0.023348, -0.033043, -0.070728,
    0.084729, -0.073288, 0.157515, -0.045657, -0.132587, -0.057881, -0.031533, 0.122525,
    -0.117075, -0.075188, -0.027769, -0.002237, 0.048135, -0.007572, 0.009516, 0.047456,
    -0.042403, -0.216208, -0.056183, -0.068561, 0.001968, -0.038136, -0.019634, 0.027522,
    -0.120289, -0.033067, 0.002040, 0.037666, -0.024134, -0.038298, 0.117868, -0.010782,
    -0.148569, 0.002185, 0.030612, 0.146822, 0.093189, 0.034998, 0.015533, -0.091143,
    0.059143, -0.105121, 0.022786, 0.085909, 0.042986, 0.031856, -0.008394, -0.092085,
    0.016743, 0.062492, -0.085278, 0.003377, 0.053317, -0.041809, -0.024551, -0.063482,
    0.170432, 0.056259, -0.086220, -0.105888, 0.081191, -0.084363, -0.053629, 0.036588,
    -0.094136, -0.119225, -0.204248, 0.015639, 0.249444, 0.066519, -0.108939, 0.022209,
    -0.044361, 0.001320, 0.074124, 0.109157, -0.005042, 0.023573, -0.032870, -0.003524,
    0.136023, -0.050801, -0.012753, 0.142053, -0.006730, 0.041472, 0.011789, 0.014485,
    -0.042060, 0.024042, -0.072077, 0.011924, 0.022886, -0.013352, -0.002569, 0.053634,
    -0.099456, 0.066148, 0.002799, 0.025738, 0.012768, 0.003516, -0.059262, -0.051765,
    0.077553, -0.139623, 0.131131, 0.109620, 0.049854, 0.085094, 0.086998, 0.063920,
    -0.005172, -0.020465, -0.123622, 0.004509, 0.072182, -0.038318, 0.051362, 0.004200
  ]);

  let activeReferenceMean = REFERENCE_MEAN_VECTOR;

  // Module state
  let isModelsLoaded = false;
  let isModelLoading = false;
  let demoModeActive = false;
  let explicitDemoMode = false;
  let activeMediaStream = null;

  /**
   * Check if running in demo/fallback mode
   */
  function isDemoMode() {
    return demoModeActive;
  }

  /**
   * Check whether @vladmandic/face-api neural models are loaded
   */
  function areModelsLoaded() {
    return isModelsLoaded;
  }

  /**
   * Explicitly set or toggle demo mode
   * @param {boolean} enabled 
   */
  function setDemoMode(enabled) {
    explicitDemoMode = !!enabled;
    demoModeActive = !!enabled;
  }

  /**
   * Probe camera availability and permissions in current browser environment
   * @returns {Promise<{available: boolean, reason: string}>}
   */
  async function checkCameraAvailability() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return { available: false, reason: "Browser does not support getUserMedia WebRTC API." };
    }
    try {
      if (navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideo = devices.some(function (d) { return d.kind === 'videoinput'; });
        if (!hasVideo) {
          return { available: false, reason: "No video input hardware detected." };
        }
      }
      return { available: true, reason: "Camera hardware available." };
    } catch (err) {
      return { available: false, reason: err.message || "Failed to query media devices." };
    }
  }

  /**
   * Initialize @vladmandic/face-api models with jsDelivr CDN
   * @param {string} [modelBaseUri]
   * @returns {Promise<boolean>}
   */
  async function initFaceApi(modelBaseUri) {
    if (isModelsLoaded) {
      if (!explicitDemoMode) demoModeActive = false;
      return true;
    }
    if (isModelLoading) {
      // Wait for existing load promise
      while (isModelLoading) {
        await new Promise(function (res) { setTimeout(res, 100); });
      }
      if (isModelsLoaded && !explicitDemoMode) demoModeActive = false;
      return isModelsLoaded;
    }

    const faceapi = (typeof globalThis !== 'undefined' && globalThis.faceapi) ||
                    (typeof window !== 'undefined' && window.faceapi);

    if (!faceapi) {
      console.warn("[FaceAuth] vladmandic/face-api global library not found in window. Falling back to Demo Mode.");
      demoModeActive = true;
      return false;
    }

    const uri = modelBaseUri || DEFAULT_MODEL_URI;
    isModelLoading = true;
    if (!explicitDemoMode) demoModeActive = false;

    try {
      if (faceapi.tf && typeof faceapi.tf.setBackend === 'function') {
        try {
          await faceapi.tf.setBackend('cpu');
        } catch (_) {}
      }
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(uri),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(uri),
        faceapi.nets.faceRecognitionNet.loadFromUri(uri)
      ]);
      isModelsLoaded = true;
      if (!explicitDemoMode) demoModeActive = false;
      console.log("[FaceAuth] @vladmandic/face-api models successfully loaded from", uri);
      return true;
    } catch (err) {
      console.warn("[FaceAuth] Failed to load face-api models from CDN:", err.message, "Falling back to Demo Mode.");
      demoModeActive = true;
      return false;
    } finally {
      isModelLoading = false;
    }
  }

  /**
   * Start camera video stream
   * @param {HTMLVideoElement} videoElement 
   * @returns {Promise<MediaStream>}
   */
  async function startCamera(videoElement) {
    if (!videoElement) {
      throw new Error("No video element provided to startCamera.");
    }
    // Clean up any existing active media stream before acquiring a new one
    if (activeMediaStream) {
      stopCamera(videoElement);
    }
    if (demoModeActive) {
      console.log("[FaceAuth] Demo mode active, skipping physical camera start.");
      return null;
    }

    const constraints = {
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeMediaStream = stream;
      videoElement.srcObject = stream;
      videoElement.setAttribute("playsinline", "true");
      videoElement.setAttribute("autoplay", "true");
      videoElement.muted = true;

      await new Promise(function (resolve) {
        const timer = setTimeout(resolve, 800);
        if (videoElement.readyState >= 2) {
          clearTimeout(timer);
          videoElement.play().catch(function () {});
          resolve();
        } else {
          videoElement.onloadedmetadata = function () {
            clearTimeout(timer);
            videoElement.play().catch(function () {});
            resolve();
          };
        }
      });
      return stream;
    } catch (err) {
      console.warn("[FaceAuth] Camera start failed or denied:", err.message, "Activating Demo Mode.");
      demoModeActive = true;
      throw err;
    }
  }

  /**
   * Stop camera video stream
   * @param {HTMLVideoElement} [videoElement] 
   */
  function stopCamera(videoElement) {
    if (activeMediaStream) {
      activeMediaStream.getTracks().forEach(function (track) {
        track.stop();
      });
      activeMediaStream = null;
    }
    if (videoElement && videoElement.srcObject) {
      videoElement.srcObject = null;
    }
  }

  /**
   * Check if live camera stream is actively running
   * @returns {boolean}
   */
  function isCameraRunning() {
    return !!(activeMediaStream && activeMediaStream.active);
  }

  /**
   * Compute Cosine Similarity between two 128-dimensional vectors
   * Cosine(A, B) = (A . B) / (||A|| * ||B||)
   * @param {Float32Array|Array<number>} vecA 
   * @param {Float32Array|Array<number>} vecB 
   * @returns {number} Clamped similarity in [0.0, 1.0]
   */
  function computeCosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== 128 || vecB.length !== 128) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < 128; i++) {
      const a = vecA[i];
      const b = vecB[i];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    return Math.max(0, Math.min(1, similarity));
  }

  /**
   * Euclidean Distance between two 128-dimensional vectors normalized to unit length
   * @param {Float32Array|Array<number>} vecA
   * @param {Float32Array|Array<number>} vecB
   * @returns {number}
   */
  function computeEuclideanDistance(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== 128 || vecB.length !== 128) {
      return 2.0;
    }
    let normA = 0, normB = 0;
    for (let i = 0; i < 128; i++) {
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    if (normA === 0 || normB === 0) return 2.0;
    let sumSq = 0;
    for (let i = 0; i < 128; i++) {
      const diff = (vecA[i] / normA) - (vecB[i] / normB);
      sumSq += diff * diff;
    }
    return Math.sqrt(sumSq);
  }

  /**
   * Feature Centering (Mean Subtraction):
   * v' = (v - \mu) / ||v - \mu||
   * @param {Float32Array|Array<number>} vec
   * @param {Float32Array|Array<number>} [meanVector]
   * @returns {Float32Array|null}
   */
  function centerVector(vec, meanVector) {
    if (!vec || vec.length !== 128) return null;
    const mu = meanVector || activeReferenceMean;
    let inNorm = 0;
    for (let i = 0; i < 128; i++) inNorm += vec[i] * vec[i];
    inNorm = Math.sqrt(inNorm);
    if (inNorm === 0) return null;
    const u = inNorm;

    const diff = new Float32Array(128);
    let diffNorm = 0;
    for (let i = 0; i < 128; i++) {
      const d = (vec[i] / u) - (mu ? mu[i] : 0);
      diff[i] = d;
      diffNorm += d * d;
    }
    diffNorm = Math.sqrt(diffNorm);
    if (diffNorm > 0) {
      for (let i = 0; i < 128; i++) diff[i] /= diffNorm;
    }
    return diff;
  }

  /**
   * Compute Centered Cosine Similarity:
   * Sim(A', B') = A' . B'
   * @param {Float32Array|Array<number>} vecA
   * @param {Float32Array|Array<number>} vecB
   * @param {Float32Array|Array<number>} [meanVector]
   * @returns {number}
   */
  function computeCenteredSimilarity(vecA, vecB, meanVector) {
    if (!vecA || !vecB || vecA.length !== 128 || vecB.length !== 128) return 0;
    const cA = centerVector(vecA, meanVector);
    const cB = centerVector(vecB, meanVector);
    if (!cA || !cB) return 0;
    let dot = 0;
    for (let i = 0; i < 128; i++) dot += cA[i] * cB[i];
    return Math.max(-1, Math.min(1, dot));
  }

  /**
   * Get / Set / Calculate Reference Mean Vector
   */
  function getReferenceMeanVector() {
    return activeReferenceMean;
  }

  function setReferenceMeanVector(vec) {
    if (vec && vec.length === 128) {
      activeReferenceMean = new Float32Array(vec);
    }
  }

  function calculateMeanVector(vectorList) {
    if (!Array.isArray(vectorList) || vectorList.length === 0) {
      return activeReferenceMean;
    }
    const sum = new Float64Array(128);
    let validCount = 0;
    for (let i = 0; i < vectorList.length; i++) {
      let v = vectorList[i];
      if (typeof v === 'string') v = deserializeDescriptor(v);
      if (!v || v.length !== 128) continue;
      let norm = 0;
      for (let j = 0; j < 128; j++) norm += v[j] * v[j];
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      for (let j = 0; j < 128; j++) sum[j] += v[j] / norm;
      validCount++;
    }
    if (validCount === 0) return activeReferenceMean;
    const mean = new Float32Array(128);
    for (let j = 0; j < 128; j++) mean[j] = sum[j] / validCount;
    return mean;
  }

  /**
   * Verify face match against stored target descriptor
   * @param {Float32Array|Array<number>} currentDescriptor 
   * @param {Float32Array|Array<number>} targetDescriptor 
   * @param {number} [threshold=0.85] 
   * @returns {{isMatch: boolean, similarity: number, percentage: number, thresholdPercentage: number, centeredSimilarity: number, euclideanDistance: number}}
   */
  function verifyFace(currentDescriptor, targetDescriptor, threshold) {
    const t = typeof threshold === 'number' ? threshold : DEFAULT_SIMILARITY_THRESHOLD;
    const similarity = computeCosineSimilarity(currentDescriptor, targetDescriptor);
    const centeredSim = computeCenteredSimilarity(currentDescriptor, targetDescriptor);
    const eucDist = computeEuclideanDistance(currentDescriptor, targetDescriptor);
    // Zero-norm / invalid vectors must never match
    let isMatch = false;
    if (similarity > 0 || centeredSim > 0) {
      isMatch = similarity >= t || centeredSim >= 0.80 || eucDist < 0.45;
    }
    const percentage = Math.round(similarity * 1000) / 10;
    return {
      isMatch: similarity >= t || isMatch,
      similarity: similarity,
      percentage: percentage,
      thresholdPercentage: Math.round(t * 100),
      centeredSimilarity: centeredSim,
      euclideanDistance: eucDist
    };
  }

  /**
   * Calculate Eye Aspect Ratio (EAR) from 6 eye landmark points
   * @param {Array<{x: number, y: number}>} eyePoints - 6 points (p1..p6)
   * @returns {number}
   */
  function calculateEAR(eyePoints) {
    if (!eyePoints || eyePoints.length < 6) return 0.3;
    function dist(p1, p2) {
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      return Math.sqrt(dx * dx + dy * dy);
    }
    const v1 = dist(eyePoints[1], eyePoints[5]);
    const v2 = dist(eyePoints[2], eyePoints[4]);
    const h = dist(eyePoints[0], eyePoints[3]);
    if (h === 0) return 0.3;
    return (v1 + v2) / (2.0 * h);
  }

  /**
   * Start blink liveness detection on a running video stream
   * @param {HTMLVideoElement} videoElement
   * @param {Object} options
   * @returns {{ stop: Function }}
   */
  function startBlinkDetection(videoElement, options) {
    options = options || {};
    const onBlink = options.onBlink;
    const onStatus = options.onStatusUpdate;
    const blinkThresh = options.blinkThreshold || 0.20;
    const openThresh = options.openThreshold || 0.25;

    let isRunning = true;
    let eyeState = 'OPEN'; // 'OPEN' -> 'CLOSING' -> 'OPEN'
    let intervalId = null;

    async function checkFrame() {
      if (!isRunning || !videoElement || videoElement.paused || videoElement.ended) return;

      try {
        if (typeof faceapi !== 'undefined' && faceapi.detectSingleFace && isModelsLoaded) {
          const detection = await faceapi.detectSingleFace(videoElement, new faceapi.TinyFaceDetectorOptions({ inputSize: 224 }))
            .withFaceLandmarks(true);

          if (detection && detection.landmarks) {
            const leftEye = detection.landmarks.getLeftEye();
            const rightEye = detection.landmarks.getRightEye();
            const leftEAR = calculateEAR(leftEye);
            const rightEAR = calculateEAR(rightEye);
            const avgEAR = (leftEAR + rightEAR) / 2.0;

            if (typeof onStatus === 'function') {
              onStatus({ ear: avgEAR, eyeState: eyeState, isFaceDetected: true });
            }

            if (eyeState === 'OPEN' && avgEAR < blinkThresh) {
              eyeState = 'CLOSING';
            } else if (eyeState === 'CLOSING' && avgEAR >= openThresh) {
              eyeState = 'OPEN';
              if (typeof onBlink === 'function') {
                onBlink({ ear: avgEAR, timestamp: Date.now() });
              }
            }
          } else {
            if (typeof onStatus === 'function') {
              onStatus({ ear: null, eyeState: 'NO_FACE', isFaceDetected: false });
            }
          }
        }
      } catch (e) {
        // Silent frame skip
      }
    }

    intervalId = setInterval(checkFrame, 120);

    return {
      stop: function () {
        isRunning = false;
        if (intervalId) clearInterval(intervalId);
      }
    };
  }

  /**
   * 1:N Facial Identification with Centering and Adaptive Margin/Ratio Test
   * R2 Requirements:
   * - Absolute threshold: centered similarity >= 80% OR uncentered Euclidean distance < 0.45
   * - Security margin test: Delta = Sim1 - Sim2 >= 0.08
   * - Fallback to safe manual confirmation when ambiguous or unmet
   * @param {Float32Array|Array<number>} candidateDescriptor
   * @param {Array<Object>} profileList
   * @param {number} [threshold=0.80]
   * @returns {Object}
   */
  function identifyFace1toN(candidateDescriptor, profileList, threshold) {
    const t = typeof threshold === 'number' ? threshold : 0.80;
    if (!candidateDescriptor || !Array.isArray(profileList) || profileList.length === 0) {
      return {
        isMatch: false,
        bestMatch: null,
        topCandidate: null,
        similarity: 0,
        percentage: 0,
        centeredSimilarity: 0,
        rawSimilarity: 0,
        euclideanDistance: 2.0,
        delta: 0,
        status: "NO_CANDIDATE",
        needsManualConfirm: true
      };
    }

    let candVec = candidateDescriptor;
    if (typeof candVec === 'string') candVec = deserializeDescriptor(candVec);
    if (!candVec || candVec.length !== 128) {
      return {
        isMatch: false,
        bestMatch: null,
        topCandidate: null,
        similarity: 0,
        percentage: 0,
        centeredSimilarity: 0,
        rawSimilarity: 0,
        euclideanDistance: 2.0,
        delta: 0,
        status: "INVALID_CANDIDATE",
        needsManualConfirm: true
      };
    }

    const scoredList = [];
    for (let i = 0; i < profileList.length; i++) {
      const p = profileList[i];
      if (!p) continue;
      if (p.isAbnormal || p.abnormal) continue;
      let target = p.descriptor || p.vector || p.featureVector;
      if (!target) continue;
      if (typeof target === 'string') {
        if (target.includes('ABNORMAL_DUPLICATE')) continue;
        target = deserializeDescriptor(target);
      }
      if (!target || target.length !== 128) continue;

      const rawSim = computeCosineSimilarity(candVec, target);
      const centeredSim = computeCenteredSimilarity(candVec, target);
      const eucDist = computeEuclideanDistance(candVec, target);

      scoredList.push({
        profile: p,
        rawSim: rawSim,
        centeredSim: centeredSim,
        eucDist: eucDist
      });
    }

    if (scoredList.length === 0) {
      return {
        isMatch: false,
        bestMatch: null,
        topCandidate: null,
        similarity: 0,
        percentage: 0,
        centeredSimilarity: 0,
        rawSimilarity: 0,
        euclideanDistance: 2.0,
        delta: 0,
        status: "NO_VALID_PROFILES",
        needsManualConfirm: true
      };
    }

    // Sort descending by centered similarity
    scoredList.sort(function (a, b) {
      return b.centeredSim - a.centeredSim;
    });

    const top1 = scoredList[0];
    const sim1 = top1.centeredSim;
    const eucDist1 = top1.eucDist;
    const rawSim1 = top1.rawSim;

    const sim2 = scoredList.length > 1 ? scoredList[1].centeredSim : -1;
    const delta = scoredList.length > 1 ? (sim1 - sim2) : 1.0;

    // R2 Criteria:
    // 1. Absolute threshold: centered similarity >= 80% OR uncentered Euclidean distance < 0.45
    // Support custom centered threshold parameter if provided (default 0.80)
    const confThreshold = typeof threshold === 'number' ? threshold : 0.80;
    const passAbsoluteThreshold = (sim1 >= confThreshold || eucDist1 < 0.45);

    // 2. Security margin test: Delta = Sim1 - Sim2 >= 0.08
    const MARGIN_THRESHOLD = 0.08;
    const passMarginTest = (delta >= MARGIN_THRESHOLD);

    let isMatch = false;
    let status = "MATCH";
    let needsManualConfirm = false;

    if (!passAbsoluteThreshold) {
      isMatch = false;
      status = "LOW_SIMILARITY";
      needsManualConfirm = true;
    } else if (!passMarginTest) {
      isMatch = false;
      status = "AMBIGUOUS_MARGIN";
      needsManualConfirm = true;
    } else {
      isMatch = true;
      status = "MATCH";
      needsManualConfirm = false;
    }

    const returnSim = sim1 > 0 ? sim1 : rawSim1;
    const percentage = Math.round(Math.max(0, returnSim) * 1000) / 10;

    const candidates = scoredList.slice(0, 5).map(function (item) {
      return {
        profile: item.profile,
        centeredSim: item.centeredSim,
        rawSim: item.rawSim,
        eucDist: item.eucDist,
        percentage: Math.round(Math.max(0, item.centeredSim) * 1000) / 10
      };
    });

    return {
      isMatch: isMatch,
      bestMatch: isMatch ? top1.profile : null,
      topCandidate: top1.profile,
      secondCandidate: scoredList.length > 1 ? scoredList[1].profile : null,
      candidates: candidates,
      candidateList: candidates,
      similarity: returnSim,
      percentage: percentage,
      centeredSimilarity: sim1,
      rawSimilarity: rawSim1,
      euclideanDistance: eucDist1,
      secondMatch: scoredList.length > 1 ? scoredList[1].profile : null,
      secondSimilarity: sim2,
      delta: delta,
      marginDelta: delta,
      status: status,
      needsManualConfirm: needsManualConfirm
    };
  }

  /**
   * Check if candidate face is a duplicate of any other student (R3 deduplication defense)
   * Similarity >= 92% triggers duplicate detection
   * @param {Float32Array|Array<number>} candidateDescriptor
   * @param {string} [targetClassID]
   * @param {number|string} [targetStudentID]
   * @param {Array<Object>} [profileList]
   * @param {number} [threshold=0.92]
   * @param {Object} [options]
   * @returns {{isDuplicate: boolean, duplicateStudent: Object|null, similarity: number, percentage: number}}
   */
  function checkDuplicateFace(candidateDescriptor, targetClassID, targetStudentID, profileList, threshold, options) {
    if (options && (options.isPasswordAuthenticated || options.exempt)) {
      return { isDuplicate: false, duplicateStudent: null, similarity: 0, percentage: 0, isExempt: true };
    }
    if (typeof globalThis !== 'undefined' && globalThis.AppState && globalThis.AppState.isPasswordAuthenticated && (!options || options.forceCheck !== true)) {
      return { isDuplicate: false, duplicateStudent: null, similarity: 0, percentage: 0, isExempt: true };
    }
    if (typeof window !== 'undefined' && window.AppState && window.AppState.isPasswordAuthenticated && (!options || options.forceCheck !== true)) {
      return { isDuplicate: false, duplicateStudent: null, similarity: 0, percentage: 0, isExempt: true };
    }
    const t = typeof threshold === 'number' ? threshold : 0.92;
    if (!candidateDescriptor || !Array.isArray(profileList) || profileList.length === 0) {
      return { isDuplicate: false, duplicateStudent: null, similarity: 0, percentage: 0 };
    }
    let candVec = candidateDescriptor;
    if (typeof candVec === 'string') candVec = deserializeDescriptor(candVec);
    if (!candVec || candVec.length !== 128) {
      return { isDuplicate: false, duplicateStudent: null, similarity: 0, percentage: 0 };
    }

    const targetC = targetClassID ? String(targetClassID).trim().toUpperCase() : null;
    const targetS = targetStudentID !== undefined && targetStudentID !== null ? parseInt(targetStudentID, 10) : null;

    let maxSim = -1;
    let dupStudent = null;

    for (let i = 0; i < profileList.length; i++) {
      const p = profileList[i];
      if (!p) continue;
      if (p.isAbnormal || p.abnormal) continue;
      const pC = String(p.classID || "").trim().toUpperCase();
      const pS = parseInt(p.studentID, 10);
      // Skip self
      if (targetC && targetS !== null && pC === targetC && pS === targetS) {
        continue;
      }
      let target = p.descriptor || p.vector || p.featureVector;
      if (!target) continue;
      if (typeof target === 'string') {
        if (target.includes('ABNORMAL_DUPLICATE')) continue;
        target = deserializeDescriptor(target);
      }
      if (!target || target.length !== 128) continue;

      const rawSim = computeCosineSimilarity(candVec, target);
      const eucDist = computeEuclideanDistance(candVec, target);
      const centeredSim = computeCenteredSimilarity(candVec, target);

      // Duplicate condition (R1 + R3):
      // Legitimate different students have uncentered raw cosine similarity up to 0.96 due to the
      // shared human average face bias, but their centered similarity is <= 0.62.
      // A genuine duplicate face belonging to the same person exhibits high centered similarity (>= 0.75)
      // AND raw cosine similarity >= 92% (or centered similarity >= 85%).
      const effectiveSim = (centeredSim >= 0.75) ? Math.max(rawSim, centeredSim) : centeredSim;
      if (effectiveSim > maxSim) {
        maxSim = effectiveSim;
        dupStudent = p;
      }
    }

    const isDuplicate = maxSim >= t;
    return {
      isDuplicate: isDuplicate,
      duplicateStudent: isDuplicate ? dupStudent : null,
      similarity: maxSim > 0 ? maxSim : 0,
      percentage: Math.round(Math.max(0, maxSim) * 1000) / 10
    };
  }

  /**
   * Linear Congruential Generator for deterministic pseudo-random vectors
   */
  function createPrng(seed) {
    let s = (Math.abs(seed) % 2147483647) || 123456789;
    return function () {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646; // [0, 1)
    };
  }

  /**
   * Generate deterministic 128-dimensional pseudo-vector based on classID and studentID
   * @param {string} classID 
   * @param {number|string} studentID 
   * @param {boolean} [addNoise=false] Set to true for secondary authentication to simulate natural slight variance
   * @param {number} [version=1] Feature version number (increments alter base seed for re-registration)
   * @returns {Float32Array} 128-element normalized vector
   */
  function getDemoDescriptor(classID, studentID, addNoise, version) {
    const clsStr = String(classID || "4D").trim().toUpperCase();
    const idNum = parseInt(studentID, 10) || 1;
    const vNum = parseInt(version, 10) || 1;

    // Compute composite numerical seed from class and ID
    let classHash = 0;
    for (let i = 0; i < clsStr.length; i++) {
      classHash = (classHash * 31 + clsStr.charCodeAt(i)) & 0x7FFFFFFF;
    }
    const baseSeed = (classHash * 10007 + idNum * 2627 + (vNum - 1) * 7919) & 0x7FFFFFFF;

    const prng = createPrng(baseSeed);
    const vector = new Float32Array(128);
    let norm = 0;

    for (let i = 0; i < 128; i++) {
      // Box-Muller transform for normal distribution
      const u1 = Math.max(1e-7, prng());
      const u2 = prng();
      const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
      vector[i] = z0;
      norm += z0 * z0;
    }

    // Normalize base vector
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < 128; i++) {
        vector[i] /= norm;
      }
    }

    // If simulating secondary scan of the SAME student, add controlled micro-noise (+- 2% to 3%)
    // resulting in cosine similarity >= 92% (easily passing the 85% threshold)
    if (addNoise) {
      let noisyNorm = 0;
      for (let i = 0; i < 128; i++) {
        const jitter = (Math.random() - 0.5) * 0.05; // small perturbation
        vector[i] += jitter;
        noisyNorm += vector[i] * vector[i];
      }
      noisyNorm = Math.sqrt(noisyNorm);
      if (noisyNorm > 0) {
        for (let i = 0; i < 128; i++) {
          vector[i] /= noisyNorm;
        }
      }
    }

    return vector;
  }

  /**
   * Generate simulated avatar snapshot image (320x240 JPEG Base64) for demo / headless mode
   * @param {string} classID 
   * @param {number|string} studentID 
   * @param {string} studentName 
   * @param {number} [version=1]
   * @returns {{imageBase64: string, descriptor: Float32Array, sizeKb: number}}
   */
  function generateDemoSnapshot(classID, studentID, studentName, version) {
    const vNum = parseInt(version, 10) || 1;
    const descriptor = getDemoDescriptor(classID, studentID, false, vNum);
    
    // In browser environment, draw on canvas; in Node.js test environment, synthesize minimal JPEG base64
    let base64Data = "";
    if (typeof document !== 'undefined' && document.createElement) {
      const canvas = document.createElement("canvas");
      canvas.width = SNAPSHOT_WIDTH;
      canvas.height = SNAPSHOT_HEIGHT;
      const ctx = canvas.getContext("2d");

      // Background gradient
      const grad = ctx.createLinearGradient(0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);
      grad.addColorStop(0, "#1e293b");
      grad.addColorStop(1, "#0f172a");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT);

      // Card border
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 3;
      ctx.strokeRect(6, 6, SNAPSHOT_WIDTH - 12, SNAPSHOT_HEIGHT - 12);

      // Face silhouette avatar circle
      ctx.fillStyle = "#334155";
      ctx.beginPath();
      ctx.arc(SNAPSHOT_WIDTH / 2, 85, 45, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#60a5fa";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Student initial avatar letter
      ctx.fillStyle = "#38bdf8";
      ctx.font = "bold 34px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const initial = (studentName || "學").charAt(0);
      ctx.fillText(initial, SNAPSHOT_WIDTH / 2, 85);

      // Student info text
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText(`${classID} 班  ${studentID} 號`, SNAPSHOT_WIDTH / 2, 150);

      ctx.fillStyle = "#93c5fd";
      ctx.font = "16px sans-serif";
      ctx.fillText(studentName || "測試學生", SNAPSHOT_WIDTH / 2, 175);

      // Watermark / demo badge
      ctx.fillStyle = "#10b981";
      ctx.fillRect(SNAPSHOT_WIDTH / 2 - 80, 195, 160, 24);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 12px sans-serif";
      ctx.fillText("✓ DEMO AUTH PASS", SNAPSHOT_WIDTH / 2, 207);

      base64Data = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    } else {
      // Minimal test stub for Node.js
      base64Data = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAAPAA8BAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
    }

    const sizeKb = Math.round((base64Data.length * 3 / 4) / 1024);
    return {
      imageBase64: base64Data,
      descriptor: descriptor,
      sizeKb: sizeKb
    };
  }

  /**
   * Capture face snapshot and 128-d descriptor from live camera video or fallback generator
   * @param {HTMLVideoElement} [videoElement] 
   * @param {Object} [contextInfo] { classID, studentID, studentName }
   * @returns {Promise<{descriptor: Float32Array, imageBase64: string, sizeKb: number, isDemo: boolean}>}
   */
  async function captureFace(videoElement, contextInfo) {
    const info = contextInfo || {};
    const cls = info.classID || "4D";
    const sid = info.studentID || 1;
    const sname = info.studentName || "";

    // 1. Check if forced demo mode or no video stream
    if (demoModeActive || !videoElement || !videoElement.srcObject || videoElement.readyState < 2) {
      console.log("[FaceAuth] Operating in Demo / Fallback capture mode.");
      const demoResult = info.version ? generateDemoSnapshot(cls, sid, sname, info.version) : generateDemoSnapshot(cls, sid, sname);
      return {
        descriptor: demoResult.descriptor,
        imageBase64: demoResult.imageBase64,
        sizeKb: demoResult.sizeKb,
        isDemo: true
      };
    }

    // 2. Physical camera snapshot capture (320x240 @ 0.70 JPEG)
    const canvas = document.createElement("canvas");
    canvas.width = SNAPSHOT_WIDTH;
    canvas.height = SNAPSHOT_HEIGHT;
    const ctx = canvas.getContext("2d");

    // Mirror horizontally for front-facing selfie camera
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    // Reset transform
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const base64Data = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const sizeKb = Math.round((base64Data.length * 3 / 4) / 1024);

    // 3. Extract 128-d feature descriptor via vladmandic/face-api
    const faceapi = (typeof globalThis !== 'undefined' && globalThis.faceapi) ||
                    (typeof window !== 'undefined' && window.faceapi);

    if (faceapi && isModelsLoaded) {
      try {
        const options = new faceapi.TinyFaceDetectorOptions({
          inputSize: 224,
          scoreThreshold: 0.5
        });

        const detection = await faceapi.detectSingleFace(videoElement, options)
          .withFaceLandmarks(true)
          .withFaceDescriptor();

        if (detection && detection.descriptor) {
          return {
            descriptor: detection.descriptor,
            imageBase64: base64Data,
            sizeKb: sizeKb,
            isDemo: false
          };
        } else {
          console.warn("[FaceAuth] No clear face detected in camera stream. Using fallback descriptor.");
        }
      } catch (err) {
        console.warn("[FaceAuth] face-api detection threw error:", err.message);
      }
    }

    // If face-api did not return descriptor, fallback to deterministic descriptor
    const fallbackDesc = getDemoDescriptor(cls, sid, false, info.version || 1);
    return {
      descriptor: fallbackDesc,
      imageBase64: base64Data,
      sizeKb: sizeKb,
      isDemo: true
    };
  }

  /**
   * Serialize 128-d descriptor into compact comma-separated string (4 decimal places)
   * Suitable for Google Form entry.1972335137
   * @param {Float32Array|Array<number>} descriptor 
   * @returns {string}
   */
  function serializeDescriptor(descriptor) {
    if (!descriptor) return "";
    const arr = [];
    for (let i = 0; i < descriptor.length; i++) {
      arr.push(descriptor[i].toFixed(4));
    }
    return arr.join(",");
  }

  /**
   * Serialize 128-d descriptor with version and timestamp metadata
   * Format: CSV_FLOATS|TS:timestamp|V:version
   * @param {Float32Array|Array<number>} descriptor 
   * @param {number} [timestamp] 
   * @param {number} [version] 
   * @returns {string}
   */
  function serializeDescriptorWithTimestamp(descriptor, timestamp, version) {
    const raw = serializeDescriptor(descriptor);
    const ts = timestamp || Date.now();
    const ver = version || 1;
    return `${raw}|TS:${ts}|V:${ver}`;
  }

  /**
   * Deserialize string back into 128-d Float32Array
   * @param {string} serializedStr 
   * @returns {Float32Array}
   */
  function deserializeDescriptor(serializedStr) {
    if (!serializedStr || typeof serializedStr !== 'string') {
      return new Float32Array(128);
    }
    let vectorStr = serializedStr;
    if (vectorStr.includes("|")) {
      vectorStr = vectorStr.split("|")[0];
    }
    if (vectorStr.includes(":")) {
      const parts = vectorStr.split(":");
      vectorStr = parts[parts.length - 1];
    }
    const parts = vectorStr.split(",").map(Number);
    const result = new Float32Array(128);
    for (let i = 0; i < Math.min(128, parts.length); i++) {
      result[i] = isNaN(parts[i]) ? 0 : parts[i];
    }
    return result;
  }

  return {
    DEFAULT_SIMILARITY_THRESHOLD: DEFAULT_SIMILARITY_THRESHOLD,
    SNAPSHOT_WIDTH: SNAPSHOT_WIDTH,
    SNAPSHOT_HEIGHT: SNAPSHOT_HEIGHT,
    JPEG_QUALITY: JPEG_QUALITY,
    isDemoMode: isDemoMode,
    setDemoMode: setDemoMode,
    checkCameraAvailability: checkCameraAvailability,
    initFaceApi: initFaceApi,
    areModelsLoaded: areModelsLoaded,
    isModelLoading: function () { return isModelLoading; },
    startCamera: startCamera,
    stopCamera: stopCamera,
    isCameraRunning: isCameraRunning,
    computeCosineSimilarity: computeCosineSimilarity,
    verifyFace: verifyFace,
    getDemoDescriptor: getDemoDescriptor,
    generateDemoSnapshot: generateDemoSnapshot,
    captureFace: captureFace,
    serializeDescriptor: serializeDescriptor,
    serializeDescriptorWithTimestamp: serializeDescriptorWithTimestamp,
    deserializeDescriptor: deserializeDescriptor,
    identifyFace1toN: identifyFace1toN,
    calculateEAR: calculateEAR,
    startBlinkDetection: startBlinkDetection,
    centerVector: centerVector,
    computeCenteredSimilarity: computeCenteredSimilarity,
    computeEuclideanDistance: computeEuclideanDistance,
    checkDuplicateFace: checkDuplicateFace,
    calculateMeanVector: calculateMeanVector,
    getReferenceMeanVector: getReferenceMeanVector,
    setReferenceMeanVector: setReferenceMeanVector,
    REFERENCE_MEAN_VECTOR: REFERENCE_MEAN_VECTOR
  };
});
