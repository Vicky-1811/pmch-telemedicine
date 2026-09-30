let socket;
let currentUser = null;
let cart = [];
let lastCalculatedBill = null;

try {
  socket = io();
} catch (e) {
  console.warn('Socket connection delayed:', e);
}

// Audio Queue Chime & Speech Synthesis
let audioCtx = null;
async function playAlertTone() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    const now = audioCtx.currentTime;
    osc.frequency.setValueAtTime(587.33, now);
    osc.frequency.setValueAtTime(880.00, now + 0.15);
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.6);
  } catch (err) {
    console.warn('Audio tone failed:', err);
  }
}

function speakTokenChime(tokenNumber, doctorName, unit) {
  playAlertTone();
  let note = document.getElementById('queueAudioNotice');
  if (!note) {
    note = document.createElement('div');
    note.id = 'queueAudioNotice';
    note.style.cssText = 'position:fixed; bottom:20px; right:20px; z-index:999999; background:#0e2a47; color:#fff; border-left:5px solid #c69214; padding:14px 18px; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.3); font-size:13px; max-width:380px;';
    document.body.appendChild(note);
  }
  note.innerHTML = `<strong>📢 TOKEN CALL: #${tokenNumber}</strong><br/><span>Doctor: ${doctorName}</span><br/><small style="color:#cbd5e1;">${unit}</small>`;
  note.style.display = 'block';
  setTimeout(() => { if (note) note.style.display = 'none'; }, 6000);

  if (!('speechSynthesis' in window)) return;
  const enText = `Token number ${tokenNumber}, please proceed to ${doctorName}, in ${unit}.`;
  const enUtter = new SpeechSynthesisUtterance(enText);
  enUtter.rate = 0.95;
  setTimeout(() => window.speechSynthesis.speak(enUtter), 450);
}

function testVoiceChime() {
  speakTokenChime(105, 'Dr. Suresh Kumar S.', 'Unit 1 / OPD Block A');
}

async function advanceOpdDoctorQueue() {
  try {
    const res = await fetch('/api/pmch/queue/advance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ doctorId: 'pmch-101' })
    });
    const data = await res.json();
    speakTokenChime(data.currentToken, data.doctorName, data.unit || 'OPD Block A');
    loadDoctors();
  } catch (err) {
    alert('Queue advance error: ' + err.message);
  }
}

// ======================== REAL GOOGLE MAPS + ANIMATED 🚑 EMOJI OVERLAYS ========================
let googleMap = null;
let customOverlayLayer = null;
let googleMapsLoaded = false;
let ambulanceEmojiOverlays = {};
let trajectoryPolylines = {};
const PMCH_LATLNG = { lat: 13.0498, lng: 80.0754 };

function promptGoogleMapsApiKey() {
  const current = localStorage.getItem('pmch_gmaps_key') || '';
  const key = prompt('Enter your Google Maps JavaScript API Key:\n(Leave blank to reset to default/demo mode)', current);
  if (key !== null) {
    localStorage.setItem('pmch_gmaps_key', key.trim());
    location.reload();
  }
}

function loadGoogleMapsScript(callback) {
  if (window.google && window.google.maps) {
    googleMapsLoaded = true;
    return callback();
  }
  const savedKey = localStorage.getItem('pmch_gmaps_key') || '';
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${savedKey}&libraries=geometry&callback=onGoogleMapsApiReady`;
  script.async = true;
  script.defer = true;
  window.onGoogleMapsApiReady = () => {
    googleMapsLoaded = true;
    callback();
  };
  script.onerror = () => {
    console.warn('Google Maps script failed to load. Showing key entry prompt.');
    const fallback = document.getElementById('gmapFallbackNotice');
    if (fallback) fallback.style.display = 'block';
  };
  document.head.appendChild(script);
}

function initGoogleMap() {
  if (googleMap) {
    google.maps.event.trigger(googleMap, 'resize');
    return;
  }
  const mapDiv = document.getElementById('ambulanceGoogleMap');
  if (!mapDiv) return;

  loadGoogleMapsScript(() => {
    const fallback = document.getElementById('gmapFallbackNotice');
    if (fallback) fallback.style.display = 'none';

    googleMap = new google.maps.Map(mapDiv, {
      center: PMCH_LATLNG,
      zoom: 13,
      mapTypeId: 'roadmap',
      styles: [
        { featureType: 'poi.business', stylers: [{ visibility: 'simplified' }] },
        { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] }
      ]
    });

    // Custom Overlay View to anchor animated DOM Emojis directly onto Google Map lat/lng
    class CustomEmojiOverlay extends google.maps.OverlayView {
      constructor() {
        super();
        this.div = document.createElement('div');
        this.div.style.position = 'absolute';
        this.div.style.width = '100%';
        this.div.style.height = '100%';
        this.div.style.pointerEvents = 'none';
      }
      onAdd() {
        const panes = this.getPanes();
        panes.overlayMouseTarget.appendChild(this.div);
      }
      draw() {
        const projection = this.getProjection();
        if (!projection) return;

        // Render Hospital Landmark Pin
        let hospPin = document.getElementById('hospBasePin');
        if (!hospPin) {
          hospPin = document.createElement('div');
          hospPin.id = 'hospBasePin';
          hospPin.className = 'gmap-hosp-pin';
          hospPin.innerHTML = '🏥 <strong>PMCH Emergency Bay</strong><br/><small style="color:#fff;">Trauma Resuscitation</small>';
          this.div.appendChild(hospPin);
        }
        const hospPixel = projection.fromLatLngToDivPixel(new google.maps.LatLng(PMCH_LATLNG.lat, PMCH_LATLNG.lng));
        if (hospPixel) {
          hospPin.style.left = `${hospPixel.x}px`;
          hospPin.style.top = `${hospPixel.y}px`;
        }

        // Render each ambulance live position
        for (const [id, data] of Object.entries(ambulanceEmojiOverlays)) {
          const pixel = projection.fromLatLngToDivPixel(new google.maps.LatLng(data.lat, data.lng));
          if (pixel && data.element) {
            data.element.style.left = `${pixel.x}px`;
            data.element.style.top = `${pixel.y}px`;
          }
        }
      }
      onRemove() {
        if (this.div.parentElement) this.div.parentElement.removeChild(this.div);
      }
    }

    customOverlayLayer = new CustomEmojiOverlay();
    customOverlayLayer.setMap(googleMap);

    loadAmbulanceFleet();
  });
}

async function loadAmbulanceFleet() {
  const res = await (await fetch('/api/pmch/ambulance/fleet')).json();
  const tbody = document.getElementById('ambulanceTableBody');
  if (tbody) {
    tbody.innerHTML = res.map(a => {
      let badgeClass = 'badge-success';
      if (a.status === 'DISPATCHED') badgeClass = 'badge-danger';
      if (a.status === 'MAINTENANCE' || a.status === 'OFFLINE') badgeClass = 'badge-gold';

      let actionButtons = '';
      if (a.status === 'AVAILABLE') {
        actionButtons = `
          <button class="btn btn-danger" style="padding:3px 7px; font-size:11px;" onclick="dispatchEmergencyAmbulance('${a.id}')">Dispatch</button>
          <button class="btn" style="padding:3px 7px; font-size:11px; background:#64748b;" onclick="setAmbulanceStatus('${a.id}', 'MAINTENANCE')">Take Offline</button>
        `;
      } else if (a.status === 'DISPATCHED') {
        actionButtons = `
          <button class="btn" style="padding:3px 7px; font-size:11px; background:#0284c7;" onclick="openParamedicModal('${a.id}')">📡 En-Route Vitals</button>
          <button class="btn" style="padding:3px 7px; font-size:11px; background:#15803d;" onclick="setAmbulanceStatus('${a.id}', 'AVAILABLE')">Dock</button>
          <button class="btn" style="padding:3px 7px; font-size:11px; background:#64748b;" onclick="setAmbulanceStatus('${a.id}', 'MAINTENANCE')">Offline</button>
        `;
      } else {
        actionButtons = `
          <button class="btn btn-gold" style="padding:3px 7px; font-size:11px;" onclick="setAmbulanceStatus('${a.id}', 'AVAILABLE')">Mark Active</button>
        `;
      }

      return `
        <tr>
          <td><strong>${a.id}</strong></td>
          <td><code>${a.vehicle_no}</code></td>
          <td>${a.driver_phone} (${a.driver_name})</td>
          <td><span class="badge ${badgeClass}">${a.status}</span></td>
          <td><strong>${a.eta_mins > 0 ? a.eta_mins + ' mins' : 'Docked'}</strong></td>
          <td style="color:#0284c7; font-size:11.5px;">${a.patient_vitals_summary}</td>
          <td><div style="display:flex; gap:4px; flex-wrap:wrap;">${actionButtons}</div></td>
        </tr>
      `;
    }).join('');
  }

  res.forEach(a => updateLiveMovingAmbulance(a));
}

// Live Moving 🚑 Emoji Engine on Google Maps
function updateLiveMovingAmbulance(a) {
  if (!customOverlayLayer || !customOverlayLayer.div) return;

  let existing = ambulanceEmojiOverlays[a.id];
  const isDispatched = a.status === 'DISPATCHED';
  const isOffline = a.status === 'MAINTENANCE' || a.status === 'OFFLINE';

  let statusClass = 'standby';
  if (isDispatched) statusClass = 'dispatched';
  if (isOffline) statusClass = 'offline';

  const sirenHtml = isDispatched ? '<span class="siren-beacon">🚨</span>' : '';
  const label = isDispatched ? `${a.eta_mins}m ETA` : a.status;

  if (!existing) {
    const el = document.createElement('div');
    el.id = `amb-marker-${a.id}`;
    el.className = 'gmap-amb-marker';
    el.style.pointerEvents = 'auto';

    el.innerHTML = `
      <div class="amb-badge-container">
        <div class="amb-emoji-bubble">🚑${sirenHtml}</div>
        <div class="amb-status-tag ${statusClass}">
          <strong>${a.id}</strong> • ${label}
        </div>
      </div>
    `;

    el.onclick = () => {
      alert(`Ambulance: ${a.id} (${a.vehicle_no})\nDriver: ${a.driver_name} (${a.driver_phone})\nStatus: ${a.status}\nVitals: ${a.patient_vitals_summary}\nETA: ${a.eta_mins} mins`);
    };

    customOverlayLayer.div.appendChild(el);
    ambulanceEmojiOverlays[a.id] = { lat: a.lat, lng: a.lng, element: el, pathHistory: [{ lat: a.lat, lng: a.lng }] };
  } else {
    existing.lat = a.lat;
    existing.lng = a.lng;
    existing.pathHistory.push({ lat: a.lat, lng: a.lng });

    // Update Tag
    const tag = existing.element.querySelector('.amb-status-tag');
    if (tag) {
      tag.className = `amb-status-tag ${statusClass}`;
      tag.innerHTML = `<strong>${a.id}</strong> • ${label}`;
    }

    const bubble = existing.element.querySelector('.amb-emoji-bubble');
    if (bubble) {
      bubble.innerHTML = `🚑${sirenHtml}`;
      bubble.style.opacity = isOffline ? '0.5' : '1.0';
    }
  }

  // Draw Trajectory Tracking Polyline on Google Maps
  if (isDispatched && googleMap) {
    if (!trajectoryPolylines[a.id]) {
      trajectoryPolylines[a.id] = new google.maps.Polyline({
        path: [new google.maps.LatLng(a.lat, a.lng), new google.maps.LatLng(PMCH_LATLNG.lat, PMCH_LATLNG.lng)],
        geodesic: true,
        strokeColor: '#dc2626',
        strokeOpacity: 0.85,
        strokeWeight: 4,
        map: googleMap
      });
    } else {
      const path = trajectoryPolylines[a.id].getPath();
      path.setAt(0, new google.maps.LatLng(a.lat, a.lng));
    }
  } else if (!isDispatched && trajectoryPolylines[a.id]) {
    trajectoryPolylines[a.id].setMap(null);
    delete trajectoryPolylines[a.id];
  }

  if (customOverlayLayer) customOverlayLayer.draw();
}

async function dispatchEmergencyAmbulance(id) {
  const res = await (await fetch('/api/pmch/ambulance/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, destination: 'PMCH Trauma Tower', vitals: 'SpO2: 91% | Pulse: 110 | Trauma Alert' })
  })).json();
  alert(`🚨 Ambulance ${id} Dispatched to PMCH Trauma Bay! Live GPS tracking active.`);
  loadAmbulanceFleet();
}

async function setAmbulanceStatus(id, status) {
  const res = await (await fetch('/api/pmch/ambulance/set-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status })
  })).json();

  if (res.success) {
    loadAmbulanceFleet();
  }
}

// Paramedic Modal Controls
function openParamedicModal(ambId) {
  document.getElementById('paramedicAmbId').value = ambId;
  document.getElementById('paramedicModalOverlay').style.display = 'flex';
}

function closeParamedicModal() {
  document.getElementById('paramedicModalOverlay').style.display = 'none';
}

async function submitParamedicTriage() {
  const id = document.getElementById('paramedicAmbId').value;
  const gcs = document.getElementById('paramedicGcs').value;
  const hr = document.getElementById('paramedicHr').value;
  const spo2 = document.getElementById('paramedicSpo2').value;
  const traumaCategory = document.getElementById('paramedicTrauma').value;
  const autoReserveIcu = document.getElementById('paramedicAutoIcu').checked;

  const res = await (await fetch('/api/pmch/ambulance/triage-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, gcs, hr, spo2, traumaCategory, autoReserveIcu })
  })).json();

  closeParamedicModal();
  let alertMsg = `📡 Triage transmitted for ${id}!\n`;
  if (res.isCritical) alertMsg += `🚨 CRITICAL ALERT TRIGGERED AT PMCH TRAUMA BAY!\n`;
  if (res.reservedBedId) alertMsg += `🛏️ ICU Bed [${res.reservedBedId}] Pre-Reserved for En-Route Patient!`;
  alert(alertMsg);
  loadAmbulanceFleet();
  loadIpdBeds();
}

// Doctor AI Ambient Voice-to-SOAP Scribe
let speechRecognition = null;
let isRecordingSoap = false;

function toggleVoiceSoapScribe() {
  const btn = document.getElementById('btnVoiceScribe');
  const soapCard = document.getElementById('soapCard');

  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    return alert('Speech Recognition API not supported in this browser. Please use Google Chrome or Edge.');
  }

  if (isRecordingSoap) {
    if (speechRecognition) speechRecognition.stop();
    isRecordingSoap = false;
    btn.innerText = '🎙️ Start AI Voice-to-SOAP Scribe';
    btn.classList.remove('recording-pulse');
    document.getElementById('scribeLiveStatus').innerText = 'SCRIBED COMPLETED';
    document.getElementById('scribeLiveStatus').className = 'badge badge-success';
    return;
  }

  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  speechRecognition = new SpeechRec();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = 'en-IN';

  soapCard.style.display = 'block';
  btn.innerText = '⏹️ Stop & Finalize Clinical Note';
  btn.classList.add('recording-pulse');
  document.getElementById('scribeLiveStatus').innerText = 'LISTENING TO CONSULTATION...';
  document.getElementById('scribeLiveStatus').className = 'badge badge-danger';
  isRecordingSoap = true;

  speechRecognition.onresult = (event) => {
    let fullTranscript = '';
    for (let i = 0; i < event.results.length; ++i) {
      fullTranscript += event.results[i][0].transcript + ' ';
    }
    parseTranscriptToSoap(fullTranscript);
  };

  speechRecognition.onerror = (err) => {
    console.warn('Speech recognition error:', err);
  };

  speechRecognition.start();
}

function parseTranscriptToSoap(text) {
  const lower = text.toLowerCase();
  let subjective = '';
  let objective = '';
  let assessment = '';
  let plan = '';

  if (lower.includes('pain') || lower.includes('fever') || lower.includes('headache') || lower.includes('cough') || lower.includes('swelling')) {
    subjective = text.trim();
  } else {
    subjective = 'Patient presents for clinical consultation. Chief complaints recorded.';
  }

  const bpMatch = text.match(/\b\d{2,3}\/\d{2,3}\b/);
  const pulseMatch = text.match(/\b\d{2,3}\s*(bpm|pulse|heart rate)\b/i);
  objective = `BP: ${bpMatch ? bpMatch[0] : '120/80 mmHg'} | Pulse: ${pulseMatch ? pulseMatch[0] : '76 bpm'} | Auscultation Clear.`;

  if (lower.includes('thrombosis') || lower.includes('clot') || lower.includes('dvt')) {
    assessment = 'Deep Vein Thrombosis & Venous Prophylaxis';
  } else if (lower.includes('infection') || lower.includes('bronchitis') || lower.includes('fever')) {
    assessment = 'Acute Bacterial Infection & Pyrexia';
  } else {
    assessment = 'Clinical Observation / Primary Care Follow-up';
  }

  if (lower.includes('warfarin') || lower.includes('aspirin')) {
    plan = 'Warfarin 5mg 1 tab OD at 6 PM.\nAspirin 75mg 1 tab OD after food.';
  } else if (lower.includes('azithromycin') || lower.includes('dolo') || lower.includes('paracetamol')) {
    plan = 'Paracetamol 650mg SOS for fever.\nAzithromycin 500mg OD x 5 days.';
  } else {
    plan = 'Paracetamol 650mg TDS PRN.\nAdequate hydration and 7-day OPD review.';
  }

  document.getElementById('soapSubjective').value = subjective;
  document.getElementById('soapObjective').value = objective;
  document.getElementById('soapAssessment').value = assessment;
  document.getElementById('soapPlan').value = plan;
}

function applySoapToPrescription() {
  const assessment = document.getElementById('soapAssessment').value;
  const plan = document.getElementById('soapPlan').value;

  document.getElementById('rxDiagnosis').value = assessment;
  if (plan.toLowerCase().includes('warfarin')) {
    document.querySelectorAll('.rx-drug-chk').forEach(chk => {
      if (chk.value.includes('Warfarin') || chk.value.includes('Aspirin')) chk.checked = true;
    });
  }
  alert('Plan transferred directly into the Digital Prescription Desk!');
}

// GS1 / 2D Barcode Scanner (html5-qrcode)
let html5QrScanner = null;
let isScannerRunning = false;

function toggleBarcodeScanner() {
  const box = document.getElementById('barcodeScannerBox');
  if (isScannerRunning) {
    if (html5QrScanner) {
      html5QrScanner.stop().then(() => {
        box.style.display = 'none';
        isScannerRunning = false;
      });
    }
    return;
  }

  box.style.display = 'block';
  html5QrScanner = new Html5Qrcode("scannerReader");
  html5QrScanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      verifyScannedBarcode(decodedText);
    },
    (errorMessage) => {}
  ).then(() => {
    isScannerRunning = true;
  }).catch(err => {
    alert("Camera access error: " + err);
  });
}

async function verifyScannedBarcode(barcode) {
  if (!barcode) return alert('Enter or scan a barcode.');
  const res = await (await fetch('/api/pmch/pharmacy/verify-barcode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ barcode: barcode.trim() })
  })).json();

  const msgDiv = document.getElementById('scanResultMsg');
  if (res.success) {
    msgDiv.innerHTML = `
      <div style="background:${res.isFefoCompliant ? '#dcfce7' : '#fee2e2'}; border:1px solid ${res.isFefoCompliant ? '#16a34a' : '#dc2626'}; padding:10px; border-radius:6px;">
        <p>${res.message}</p>
        <p><strong>Medicine:</strong> ${res.scannedBatch.medicine_name} | Batch: <code>${res.scannedBatch.batch_number}</code> | Expiry: <strong>${res.scannedBatch.expiry_date}</strong></p>
        ${res.isFefoCompliant ? `<button class="btn btn-gold" style="margin-top:6px;" onclick="addToCart('${res.scannedBatch.medicine_id}', '${res.scannedBatch.medicine_name}',${res.scannedBatch.unit_price})">Add Verified Batch to Dispense Cart</button>` : ''}
      </div>
    `;
  } else {
    msgDiv.innerHTML = `<span style="color:#dc2626;">❌ ${res.message}</span>`;
  }
}

// WhatsApp Live Toast
function displayWhatsAppToast(phone, body) {
  const toast = document.getElementById('whatsappLiveToast');
  if (!toast) return;
  document.getElementById('waToastBody').innerText = `To: ${phone}\n\n${body}`;
  document.getElementById('waToastTime').innerText = new Date().toLocaleTimeString('en-IN');
  toast.style.display = 'block';
  setTimeout(() => { if (toast) toast.style.display = 'none'; }, 8000);
}

async function sendManualWhatsApp() {
  const phone = document.getElementById('manualAlertPhone').value;
  const templateName = document.getElementById('manualAlertTemplate').value;
  const messageBody = document.getElementById('manualAlertMsg').value;

  const res = await (await fetch('/api/pmch/notifications/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'WHATSAPP', phone, templateName, messageBody })
  })).json();

  alert(res.message);
  loadNotificationLogs();
}

async function loadNotificationLogs() {
  const res = await (await fetch('/api/pmch/notifications/recent')).json();
  const tbody = document.getElementById('notificationLogBody');
  if (!tbody) return;
  tbody.innerHTML = res.map(l => `
    <tr>
      <td><span class="badge ${l.channel === 'WHATSAPP' ? 'badge-success' : 'badge-navy'}">${l.channel}</span></td>
      <td><code>${l.recipient_phone}</code></td>
      <td><strong>${l.template_name}</strong></td>
      <td style="font-size:11.5px; max-width:320px;">${l.message_body}</td>
      <td><span class="badge badge-success">${l.status}</span></td>
      <td><small>${l.sent_at}</small></td>
    </tr>
  `).join('');
}

// WebSocket Event Listeners
if (socket) {
  socket.on('ambulance-telemetry-update', (data) => {
    updateLiveMovingAmbulance(data);
    loadAmbulanceFleet();
  });

  socket.on('trauma-triage-alert', (data) => {
    const banner = document.getElementById('traumaAlertBanner');
    if (banner) {
      document.getElementById('traumaAmbId').innerText = data.ambulanceId;
      document.getElementById('traumaEta').innerText = data.etaMins;
      document.getElementById('traumaType').innerText = data.traumaCategory;
      document.getElementById('traumaSpo2').innerText = `${data.spo2}%`;
      document.getElementById('traumaHr').innerText = data.hr;
      document.getElementById('traumaBedNotice').innerText = data.reservedBedId ? `ICU Bed [${data.reservedBedId}] Pre-Reserved.` : 'Trauma Team Scrubbed.';
      banner.style.display = 'block';
    }
  });

  socket.on('whatsapp-dispatched', (data) => {
    displayWhatsAppToast(data.phone || '+91 98765 43210', data.message);
    loadNotificationLogs();
  });

  socket.on('video-offer', async ({ offer }) => {
    if (!peerConnection) {
      peerConnection = new RTCPeerConnection(rtcConfig);
      if (localStream) localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
      peerConnection.ontrack = (e) => document.getElementById('remoteVideo').srcObject = e.streams[0];
      peerConnection.onicecandidate = (e) => {
        if (e.candidate) socket.emit('ice-candidate', { roomId: telemedRoomId, candidate: e.candidate });
      };
    }
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('video-answer', { roomId: telemedRoomId, answer });
  });

  socket.on('video-answer', async ({ answer }) => {
    if (peerConnection) await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (peerConnection && candidate) {
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
  });

  socket.on('peer-left', () => {
    document.getElementById('remoteVideo').srcObject = null;
  });

  socket.on('token-called', (data) => {
    speakTokenChime(data.tokenNumber, data.doctorName, data.unit || 'OPD Block A');
    loadDoctors();
  });

  socket.on('telemetry-update', (data) => {
    const hrEl = document.getElementById('liveHr');
    const spo2El = document.getElementById('liveSpo2');
    const bpEl = document.getElementById('liveBp');
    const timeEl = document.getElementById('telemetryTime');
    const bedEl = document.getElementById('telemetryBedId');
    const uhidEl = document.getElementById('telemetryUhid');

    if (hrEl) hrEl.innerText = data.hr;
    if (spo2El) {
      spo2El.innerText = data.spo2;
      spo2El.style.color = data.spo2 < 90 ? '#f87171' : '#38bdf8';
    }
    if (bpEl) bpEl.innerText = data.bp;
    if (timeEl) timeEl.innerText = `Live at ${data.timestamp}`;
    if (bedEl) bedEl.innerText = data.bedId;
    if (uhidEl) uhidEl.innerText = data.uhid;
  });

  socket.on('code-blue-alert', (data) => {
    const banner = document.getElementById('codeBlueBanner');
    if (banner) {
      document.getElementById('cbBed').innerText = data.bedId;
      document.getElementById('cbLoc').innerText = data.location;
      document.getElementById('cbSpo2').innerText = `${data.spo2}%`;
      banner.style.display = 'block';
    }
  });
}

function dismissCodeBlue() {
  const banner = document.getElementById('codeBlueBanner');
  if (banner) banner.style.display = 'none';
}

async function simulateCodeBlue() {
  if (!currentUser || (currentUser.role !== 'ADMIN' && currentUser.role !== 'DOCTOR')) {
    return alert('Access Restricted: Admin or Consulting Doctors only.');
  }
  await fetch('/api/pmch/telemetry/trigger-code-blue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bedId: 'BED-ICU-01', uhid: 'PMCH-80097' })
  });
}

// WebRTC Video Controls
let localStream = null;
let peerConnection = null;
const telemedRoomId = 'pmch-consultation-room-101';
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

async function startTelemedCall() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('localVideo').srcObject = localStream;

    peerConnection = new RTCPeerConnection(rtcConfig);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    peerConnection.ontrack = (event) => {
      document.getElementById('remoteVideo').srcObject = event.streams[0];
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('ice-candidate', { roomId: telemedRoomId, candidate: event.candidate });
      }
    };

    if (socket) {
      socket.emit('join-video-room', telemedRoomId);
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('video-offer', { roomId: telemedRoomId, offer });
    }
  } catch (err) {
    alert('Camera/Microphone access error: ' + err.message);
  }
}

function endTelemedCall() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('remoteVideo').srcObject = null;
  if (socket) socket.emit('leave-video-room', telemedRoomId);
  alert('Telemedicine consultation ended.');
}

function toggleLocalAudio() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    document.getElementById('btnToggleAudio').innerText = track.enabled ? '🎙 Mute Mic' : '🔇 Unmute Mic';
  }
}

function toggleLocalVideo() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    document.getElementById('btnToggleVideo').innerText = track.enabled ? '📷 Turn Off Camera' : '🎥 Turn On Camera';
  }
}

// UPI QR Gateway Modal
let activePaymentCallback = null;
let upiTimerInterval = null;

async function launchUpiPaymentModal({ amount, purpose, uhid, onComplete }) {
  if (!amount || amount <= 0) {
    if (onComplete) onComplete({ success: true, txnRef: 'PMCH-FREE-PASS' });
    return;
  }

  const res = await (await fetch('/api/pmch/payment/generate-upi-qr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, purpose, uhid })
  })).json();

  if (!res.success) return alert('Failed to initiate UPI transaction.');

  document.getElementById('upiQrImage').src = res.qrDataUrl;
  document.getElementById('upiPayAmount').innerText = `₹${res.amount.toFixed(2)}`;
  document.getElementById('upiTxnRef').innerText = res.txnRef;
  document.getElementById('upiModalOverlay').style.display = 'flex';

  activePaymentCallback = onComplete;

  let seconds = 180;
  clearInterval(upiTimerInterval);
  upiTimerInterval = setInterval(() => {
    seconds--;
    const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
    const secs = String(seconds % 60).padStart(2, '0');
    document.getElementById('upiTimer').innerText = `${mins}:${secs}`;
    if (seconds <= 0) {
      clearInterval(upiTimerInterval);
      closeUpiModal();
      alert('UPI transaction window expired.');
    }
  }, 1000);
}

function closeUpiModal() {
  clearInterval(upiTimerInterval);
  document.getElementById('upiModalOverlay').style.display = 'none';
  activePaymentCallback = null;
}

function simulateUpiApproval() {
  const txnRef = document.getElementById('upiTxnRef').innerText;
  closeUpiModal();
  alert(`💳 UPI Payment Successful!\nBank Ref: ${txnRef}\nStatus: SETTLED`);
  if (activePaymentCallback) {
    activePaymentCallback({ success: true, txnRef });
  }
}

async function bookToken(doctorId, doctorName, fee) {
  launchUpiPaymentModal({
    amount: fee,
    purpose: `OPD Consultation with ${doctorName}`,
    uhid: getActiveUhid(),
    onComplete: async ({ txnRef }) => {
      const res = await (await fetch('/api/pmch/confirm-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doctorId,
          patientName: currentUser?.name || 'Patient',
          patientPhone: '+91 98765 43210',
          uhid: getActiveUhid(),
          amount: fee,
          paymentId: txnRef
        })
      })).json();
      alert(`Token #${res.tokenNumber} confirmed for ${res.doctorName}`);
      loadDoctors();
    }
  });
}

function initiatePharmacyCheckout() {
  if (cart.length === 0) return alert('Cart empty');
  const total = cart.reduce((s, i) => s + (i.price * i.qty), 0);

  launchUpiPaymentModal({
    amount: total,
    purpose: 'Central Pharmacy FEFO Medications',
    uhid: getActiveUhid(),
    onComplete: async ({ txnRef }) => {
      const res = await (await fetch('/api/pmch/pharmacy/dispense', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cart, uhid: getActiveUhid(), paymentId: txnRef })
      })).json();
      alert(`Pharmacy Order Dispensed!\nOrder ID: ${res.order.orderId}\nUPI Ref: ${txnRef}`);
      cart = [];
      document.getElementById('cartCount').innerText = 0;
      loadPharmacy();
      loadBatches();
    }
  });
}

async function initiateDischargeUpiPayment() {
  const targetUhid = getActiveUhid();
  if (!lastCalculatedBill || lastCalculatedBill.uhid !== targetUhid) {
    lastCalculatedBill = await calculateHospitalBill(targetUhid);
  }

  launchUpiPaymentModal({
    amount: lastCalculatedBill.patientCopay,
    purpose: `Discharge Co-Pay Settlement for ${lastCalculatedBill.uhid}`,
    uhid: targetUhid,
    onComplete: async ({ txnRef }) => {
      const res = await (await fetch('/api/pmch/billing/settle-discharge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uhid: lastCalculatedBill.uhid,
          doctorFee: lastCalculatedBill.doctorFee,
          pharmacyTotal: lastCalculatedBill.pharmacyTotal,
          labTotal: lastCalculatedBill.labTotal,
          bedCharges: lastCalculatedBill.bedCharges,
          grandTotal: lastCalculatedBill.grandTotal,
          insuranceCovered: lastCalculatedBill.insuranceCovered,
          patientCopay: lastCalculatedBill.patientCopay,
          tpaName: lastCalculatedBill.insurancePolicy ? lastCalculatedBill.insurancePolicy.tpa_provider : 'Cash/UPI',
          paymentId: txnRef
        })
      })).json();

      if (res.success) {
        lastCalculatedBill.billId = res.billId;
        lastCalculatedBill.claimId = res.claimId;
        lastCalculatedBill.dischargeDate = res.dischargeDate;
        document.getElementById('billInvoiceNo').innerText = res.billId;
        alert(`✅ Discharge Settled!\nInvoice: ${res.billId}\nUPI Ref: ${txnRef}`);
      }
    }
  });
}

// Bedside Oscilloscope Canvas
let ecgX = 0;
let lastY = 45;
function initEcgWaveform() {
  const canvas = document.getElementById('ecgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function drawSweep() {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.fillRect(ecgX, 0, 8, canvas.height);

    let y = 45;
    const cycle = ecgX % 75;
    if (cycle > 28 && cycle < 32) y = 42;
    else if (cycle === 33) y = 52;
    else if (cycle === 34) y = 12;
    else if (cycle === 35) y = 65;
    else if (cycle > 42 && cycle < 48) y = 38;
    else y = 45 + (Math.random() * 2 - 1);

    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(ecgX === 0 ? 0 : ecgX - 2, lastY);
    ctx.lineTo(ecgX, y);
    ctx.stroke();

    lastY = y;
    ecgX = (ecgX + 2) % canvas.width;
    requestAnimationFrame(drawSweep);
  }
  requestAnimationFrame(drawSweep);
}

// ABDM Sandbox
function getActiveUhid() {
  if (currentUser && currentUser.role === 'PATIENT') {
    const match = currentUser.department?.match(/PMCH-\d+/);
    return match ? match[0] : 'PMCH-80097';
  }
  return document.getElementById('billingUhid')?.value?.trim() || 'PMCH-80097';
}

async function loadAbhaDossier(uhid) {
  const targetUhid = uhid || getActiveUhid();
  const box = document.getElementById('abhaStatusDossier');
  if (!box) return;

  const res = await (await fetch('/api/pmch/abdm/profile/' + targetUhid)).json();
  if (res.linked) {
    box.innerHTML = `
      <div style="background: #f0fdf4; border: 1px solid #16a34a; padding: 12px; border-radius: 6px;">
        <span class="badge badge-success">ABHA VERIFIED & ACTIVE</span><br/>
        <p style="margin-top: 6px;"><strong>ABHA 14-Digit ID:</strong> <code>${res.abha.abha_number}</code></p>
        <p><strong>ABHA Address:</strong> <code>${res.abha.abha_address}</code> | Name: <strong>${res.abha.full_name}</strong></p>
        <p><strong>Consent Artifact:</strong> ${res.consent ? `<span class="badge badge-navy">ID: ${res.consent.consent_id} (${res.consent.expiry_hours}h valid)</span>` : '<span class="badge badge-gold">No active consent</span>'}</p>
      </div>
    `;
  } else {
    box.innerHTML = '<p style="color: #94a3b8; font-size: 12px;">No ABHA National Health ID linked to this patient UHID. Generate below.</p>';
  }
}

async function generatePatientAbha() {
  const uhid = document.getElementById('abhaUhid').value.trim();
  const fullName = document.getElementById('abhaName').value.trim();
  const mobile = document.getElementById('abhaMobile').value.trim();
  const gender = document.getElementById('abhaGender').value;

  if (!uhid || !fullName || !mobile) return alert('Enter UHID, Name, and Mobile');

  const res = await (await fetch('/api/pmch/abdm/generate-abha', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uhid, fullName, mobile, gender })
  })).json();

  alert(`ABHA Linked!\nABHA ID: ${res.abhaNumber}\nAddress: ${res.abhaAddress}`);
  loadAbhaDossier(uhid);
}

async function grantAbdmConsent() {
  const uhid = getActiveUhid();
  const doctorId = document.getElementById('consentDoctor').value;
  const hours = document.getElementById('consentHours').value;

  const res = await (await fetch('/api/pmch/abdm/grant-consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uhid, doctorId, hours })
  })).json();

  alert(res.message);
  loadAbhaDossier(uhid);
}

async function viewFhirBundle() {
  const uhid = getActiveUhid();
  const bundle = await (await fetch('/api/pmch/abdm/fhir-bundle/' + uhid)).json();
  const win = window.open('', '_blank');
  win.document.write(`<pre style="font-family: monospace; background: #0f172a; color: #38bdf8; padding: 20px;">${JSON.stringify(bundle, null, 2)}</pre>`);
}

// TPA Insurance Desk
async function registerPatientInsurance() {
  const uhid = document.getElementById('insUhid')?.value.trim() || getActiveUhid();
  const tpaProvider = document.getElementById('insProvider').value;
  const policyNo = document.getElementById('insPolicyNo').value.trim();
  const preauthApprovalLimit = document.getElementById('insPreauth').value;
  const coveragePercent = document.getElementById('insPercent').value;

  if (!uhid || !policyNo) return alert('Enter UHID and Policy Number');

  const res = await (await fetch('/api/pmch/insurance/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uhid, tpaProvider, policyNo, preauthApprovalLimit, coveragePercent })
  })).json();

  alert(res.message);
  loadInsuranceDossier(uhid);
}

async function loadInsuranceDossier(uhid) {
  const targetUhid = uhid || getActiveUhid();
  const box = document.getElementById('insActivePolicyDossier');
  if (!box) return;

  const data = await (await fetch('/api/pmch/insurance/policy/' + targetUhid)).json();
  if (data && data.status === 'ACTIVE') {
    box.innerHTML = `
      <div style="background: #f0fdf4; border: 1px solid #16a34a; padding: 12px; border-radius: 6px;">
        <strong style="color: #15803d;">Active Cashless Coverage:</strong><br/>
        <span>Provider / Scheme: <strong>${data.tpa_provider}</strong></span><br/>
        <span>Policy ID: <code>${data.policy_no}</code> | Coverage: <strong>${data.coverage_percent}%</strong></span><br/>
        <span>Pre-Auth Limit: <strong>₹${data.preauth_approval_limit}</strong></span>
      </div>
    `;
  } else {
    box.innerHTML = '<p style="color: #94a3b8; font-size: 12px;">No active insurance linked.</p>';
  }
}

// Billing Dossier
async function calculateHospitalBill(optionalUhid) {
  const targetUhid = optionalUhid || document.getElementById('billingUhid')?.value?.trim() || getActiveUhid();
  const data = await (await fetch('/api/pmch/billing/summary/' + targetUhid)).json();

  lastCalculatedBill = data;
  document.getElementById('billInvoiceNo').innerText = 'PENDING_SETTLEMENT';
  document.getElementById('billDate').innerText = new Date().toLocaleDateString('en-IN');
  document.getElementById('dispTotalBill').innerText = data.grandTotal;
  document.getElementById('dispInsCovered').innerText = data.insuranceCovered;
  document.getElementById('dispPatientCopay').innerText = data.patientCopay;
  document.getElementById('dispInsName').innerText = data.insurancePolicy ? data.insurancePolicy.tpa_provider : 'Direct Self-Pay';
  document.getElementById('dischargeSlip').style.display = 'block';
  return data;
}

function generateDischargePdf() {
  if (!lastCalculatedBill || !lastCalculatedBill.billId) return alert('Settle discharge before PDF generation.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  doc.setFillColor(14, 42, 71);
  doc.rect(0, 0, 210, 36, 'F');
  doc.setTextColor(198, 146, 20);
  doc.setFontSize(13);
  doc.setFont('helvetica', 'bold');
  doc.text('PANIMALAR MEDICAL COLLEGE HOSPITAL & RESEARCH INSTITUTE', 105, 14, { align: 'center' });
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text('Poonamallee, Chennai - 600123 | NABH & NABL Accredited | ABDM Interoperable', 105, 21, { align: 'center' });
  doc.text('FINAL DISCHARGE DOSSIER & ITEMIZED TPA ADJUDICATION INVOICE', 105, 28, { align: 'center' });

  doc.setTextColor(30, 41, 59);
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'bold');
  doc.text('UHID:', 14, 44);
  doc.setFont('helvetica', 'normal');
  doc.text(lastCalculatedBill.uhid, 40, 44);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE ID:', 14, 50);
  doc.setFont('helvetica', 'normal');
  doc.text(lastCalculatedBill.billId, 40, 50);
  doc.setFont('helvetica', 'bold');
  doc.text('DISCHARGE DATE:', 125, 44);
  doc.setFont('helvetica', 'normal');
  doc.text(lastCalculatedBill.dischargeDate, 168, 44);
  doc.setFont('helvetica', 'bold');
  doc.text('TPA / SCHEME:', 125, 50);
  doc.setFont('helvetica', 'normal');
  doc.text(lastCalculatedBill.insurancePolicy ? lastCalculatedBill.insurancePolicy.tpa_provider : 'Self-Pay', 168, 50);

  doc.setDrawColor(203, 213, 225);
  doc.line(14, 55, 196, 55);

  doc.setTextColor(14, 42, 71);
  doc.setFont('helvetica', 'bold');
  doc.text('Departmental Clinical Services', 16, 64);
  doc.text('Charges (INR)', 160, 64);
  doc.line(14, 68, 196, 68);

  doc.setTextColor(51, 65, 85);
  doc.setFont('helvetica', 'normal');
  let y = 76;
  const items = [
    ['Specialist OPD Consultation & Rounds', `INR ${lastCalculatedBill.doctorFee}.00`],
    ['Central Pharmacy Medications (FEFO)', `INR ${lastCalculatedBill.pharmacyTotal}.00`],
    ['Pathology & Radiology Diagnostics (LIMS)', `INR ${lastCalculatedBill.labTotal}.00`],
    [`Inpatient Bed Care (${lastCalculatedBill.bedDetails?.ward_type || 'General Care'})`, `INR ${lastCalculatedBill.bedCharges}.00`]
  ];
  items.forEach(([desc, amt]) => {
    doc.text(desc, 16, y);
    doc.text(amt, 160, y);
    y += 9;
  });

  doc.line(14, y, 196, y);
  y += 7;
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL HOSPITAL CHARGES:', 16, y);
  doc.text(`INR ${lastCalculatedBill.grandTotal}.00`, 160, y);
  y += 7;

  doc.setFillColor(241, 245, 249);
  doc.rect(14, y, 182, 22, 'F');
  y += 6;
  doc.setTextColor(21, 128, 61);
  doc.text('TPA Covered / Claimed Amount:', 18, y);
  doc.text(`INR ${lastCalculatedBill.insuranceCovered}.00`, 160, y);
  y += 7;
  doc.setTextColor(185, 28, 28);
  doc.text('Net Patient Co-Pay Settled:', 18, y);
  doc.text(`INR ${lastCalculatedBill.patientCopay}.00`, 160, y);

  y += 28;
  doc.setTextColor(100, 116, 139);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text('TPA Claims Desk Officer', 16, y);
  doc.text('Medical Superintendent Signature', 140, y);
  doc.line(14, y + 2, 60, y + 2);
  doc.line(138, y + 2, 194, y + 2);

  doc.save(`PMCH-Discharge-Claim-${lastCalculatedBill.uhid}.pdf`);
}

// Clinical AI
async function runAiInteractionCheck() {
  const selectedDrugs = Array.from(document.querySelectorAll('.rx-drug-chk:checked')).map(el => el.value);
  const allergies = [];
  if (document.getElementById('algPenicillin')?.checked) allergies.push('Penicillin');

  const res = await (await fetch('/api/pmch/ai/check-interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedDrugs, patientAllergies: allergies })
  })).json();

  const alertBox = document.getElementById('aiAlertContainer');
  alertBox.style.display = 'block';
  if (res.safe) {
    alertBox.style.background = '#dcfce7';
    alertBox.style.border = '1px solid #16a34a';
    alertBox.innerHTML = '<strong style="color: #15803d;">✅ Clinical AI Clearance:</strong> No known drug interactions detected.';
  } else {
    alertBox.style.background = res.hasCritical ? '#fee2e2' : '#fef3c7';
    alertBox.style.border = res.hasCritical ? '1px solid #dc2626' : '1px solid #d97706';
    alertBox.innerHTML = `
      <strong style="color: ${res.hasCritical ? '#991b1b' : '#92400e'};">⚠️ Clinical Safety Alert:</strong>
      <ul style="margin: 6px 0 0 16px; font-size: 12.5px;">
        ${res.warnings.map(w => `<li><strong>[${w.severity}] ${w.title}:</strong>${w.description}</li>`).join('')}
      </ul>
    `;
  }
}

async function generatePrescription() {
  const selectedDrugs = Array.from(document.querySelectorAll('.rx-drug-chk:checked')).map(el => el.value);
  if (selectedDrugs.length === 0) return alert('Select at least one drug.');

  const res = await (await fetch('/api/pmch/prescription/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uhid: document.getElementById('rxUhid').value,
      doctorName: document.getElementById('rxDoctor').value,
      diagnosis: document.getElementById('rxDiagnosis').value,
      medications: selectedDrugs.join('\n')
    })
  })).json();
  if (res.success) alert('Official Prescription Digitally Signed!');
}

// Authentication
let isOtpLogin = false;

function toggleLoginMethod() {
  isOtpLogin = !isOtpLogin;
  const toggleBtn = document.getElementById('toggleLoginBtn');
  const pwdBlock = document.getElementById('passwordInputBlock');
  const otpBlock = document.getElementById('otpInputBlock');
  const idLabel = document.getElementById('idFieldLabel');
  const idInput = document.getElementById('loginUsername');

  if (isOtpLogin) {
    toggleBtn.innerText = 'Switch to Password Login';
    idLabel.innerText = 'Registered Email Address:';
    idInput.placeholder = 'Enter your email (e.g., patient@gmail.com)';
    pwdBlock.style.display = 'none';
    document.getElementById('loginPassword').removeAttribute('required');
    otpBlock.style.display = 'block';
  } else {
    toggleBtn.innerText = 'Switch to Email OTP';
    idLabel.innerText = 'Email Address or Username:';
    idInput.placeholder = 'name@domain.com or username';
    pwdBlock.style.display = 'block';
    document.getElementById('loginPassword').setAttribute('required', 'true');
    otpBlock.style.display = 'none';
  }
}

async function requestLoginEmailOtp() {
  const email = document.getElementById('loginUsername').value.trim();
  if (!email || !email.includes('@')) return alert('Please enter a valid email address first.');

  const res = await (await fetch('/api/pmch/auth/send-email-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email })
  })).json();

  if (res.success) {
    alert(res.message + '\n[DEMO CODE: ' + res.demoOtp + ']');
    document.getElementById('loginOtpCode').value = res.demoOtp;
  } else {
    alert(res.error || 'Failed to send code.');
  }
}

function fillLogin(role, pwd) {
  const idInput = document.getElementById('loginUsername');
  const pwdInput = document.getElementById('loginPassword');
  if (role === 'admin') {
    idInput.value = 'admin@panimalar.ac.in';
    pwdInput.value = 'admin123';
  } else if (role === 'doctor') {
    idInput.value = 'suresh.kumar@panimalar.ac.in';
    pwdInput.value = 'doctor123';
  } else {
    idInput.value = 'kavitha.patient@gmail.com';
    pwdInput.value = 'patient123';
  }
  if (isOtpLogin) toggleLoginMethod();
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const identifier = document.getElementById('loginUsername').value.trim();

  if (isOtpLogin) {
    const otp = document.getElementById('loginOtpCode').value.trim();
    if (!otp) return alert('Please enter the 6-digit OTP sent to your email.');
    const res = await (await fetch('/api/pmch/auth/verify-email-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: identifier, otp })
    })).json();

    if (res.success) {
      currentUser = res.user;
      sessionStorage.setItem('pmch_user', JSON.stringify(currentUser));
      document.getElementById('loginOverlay').style.display = 'none';
      applyRolePermissions(currentUser);
    } else {
      alert(res.error || 'OTP verification failed');
    }
  } else {
    const password = document.getElementById('loginPassword').value;
    const res = await (await fetch('/api/pmch/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: identifier, email: identifier, password })
    })).json();

    if (res.success) {
      currentUser = res.user;
      sessionStorage.setItem('pmch_user', JSON.stringify(currentUser));
      document.getElementById('loginOverlay').style.display = 'none';
      applyRolePermissions(currentUser);
    } else {
      alert(res.error || 'Authentication failed');
    }
  }
}

function applyRolePermissions(user) {
  document.getElementById('sessionUserName').innerText = user.name;
  document.getElementById('sessionUserDept').innerText = user.department;
  document.getElementById('sessionUserRole').innerText = user.role;

  const navAdmin = document.getElementById('nav-admin');
  const navTelemed = document.getElementById('nav-telemed');
  const navAmbulance = document.getElementById('nav-ambulance');
  const navAlerts = document.getElementById('nav-alerts');
  const navAbdm = document.getElementById('nav-abdm');
  const navInsurance = document.getElementById('nav-insurance');
  const navRx = document.getElementById('nav-rx');
  const navOpd = document.getElementById('nav-opd');
  const navPharmacy = document.getElementById('nav-pharmacy');
  const navIpd = document.getElementById('nav-ipd');
  const navLims = document.getElementById('nav-lims');
  const navBilling = document.getElementById('nav-billing');

  const activeUhid = getActiveUhid();
  if (document.getElementById('billingUhid')) document.getElementById('billingUhid').value = activeUhid;
  if (document.getElementById('insUhid')) document.getElementById('insUhid').value = activeUhid;
  if (document.getElementById('abhaUhid')) document.getElementById('abhaUhid').value = activeUhid;

  if (navAmbulance) navAmbulance.style.display = 'inline-block';
  if (navAlerts) navAlerts.style.display = 'inline-block';

  if (user.role === 'ADMIN') {
    [navAdmin, navTelemed, navAbdm, navInsurance, navRx, navOpd, navPharmacy, navIpd, navLims, navBilling].forEach(el => { if (el) el.style.display = 'inline-block'; });
    switchTab('tab-admin');
  } else if (user.role === 'DOCTOR') {
    if (navAdmin) navAdmin.style.display = 'none';
    if (navInsurance) navInsurance.style.display = 'none';
    if (navPharmacy) navPharmacy.style.display = 'none';
    if (navBilling) navBilling.style.display = 'none';
    [navOpd, navTelemed, navRx, navIpd, navLims, navAbdm].forEach(el => { if (el) el.style.display = 'inline-block'; });
    switchTab('tab-opd');
  } else {
    if (navAdmin) navAdmin.style.display = 'none';
    if (navRx) navRx.style.display = 'none';
    if (navIpd) navIpd.style.display = 'none';
    if (navLims) navLims.style.display = 'none';
    [navOpd, navTelemed, navPharmacy, navBilling, navInsurance, navAbdm].forEach(el => { if (el) el.style.display = 'inline-block'; });
    switchTab('tab-opd');
  }

  loadDoctors();
  loadPharmacy();
  loadAbhaDossier(activeUhid);
  loadInsuranceDossier(activeUhid);
  setTimeout(initEcgWaveform, 200);
}

function handleLogout() {
  sessionStorage.removeItem('pmch_user');
  currentUser = null;
  document.getElementById('loginOverlay').style.display = 'flex';
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  const target = document.getElementById(tabId);
  if (target) target.classList.add('active');

  const btn = Array.from(document.querySelectorAll('.nav-btn')).find(b => b.getAttribute('onclick')?.includes(tabId));
  if (btn) btn.classList.add('active');

  const activeUhid = getActiveUhid();
  if (tabId === 'tab-ambulance') {
    setTimeout(initGoogleMap, 200);
    loadAmbulanceFleet();
  }
  if (tabId === 'tab-alerts') loadNotificationLogs();
  if (tabId === 'tab-pharmacy') { loadPharmacy(); loadBatches(); }
  if (tabId === 'tab-ipd') { loadIpdBeds(); setTimeout(initEcgWaveform, 150); }
  if (tabId === 'tab-lims') { loadLimsCatalog(); loadLimsWorklist(); }
  if (tabId === 'tab-admin') loadAdminDropdowns();
  if (tabId === 'tab-abdm') loadAbhaDossier(activeUhid);
  if (tabId === 'tab-insurance') loadInsuranceDossier(activeUhid);
  if (tabId === 'tab-billing') calculateHospitalBill(activeUhid);
  if (tabId === 'tab-ehr') lookupPatientEhr();
}

async function loadDoctors() {
  const res = await (await fetch('/api/pmch/doctors')).json();
  const list = document.getElementById('doctorList');
  if (!list) return;
  list.innerHTML = res.map(d => `
    <div class="card">
      <div style="display: flex; justify-content: space-between;">
        <span class="badge badge-navy">${d.specialty}</span>
        <strong>Serving: Token #${d.current_token}</strong>
      </div>
      <h3 style="margin: 6px 0;">${d.name}</h3>
      <p style="font-size: 12px; color: #64748b;">${d.unit}</p>
      <button class="btn btn-gold" style="width: 100%; margin-top: 8px;" onclick="bookToken('${d.id}', '${d.name}', ${d.fee})">Book Token (₹${d.fee})</button>
    </div>
  `).join('');
}

async function loadPharmacy() {
  const res = await (await fetch('/api/pmch/pharmacy')).json();
  const list = document.getElementById('pharmacyList');
  if (!list) return;
  list.innerHTML = res.map(m => `
    <div class="card">
      <div style="display: flex; justify-content: space-between;"><span class="badge badge-navy">Stock: ${m.stock}</span><strong>₹${m.price}</strong></div>
      <h3 style="margin: 6px 0;">${m.name}</h3>
      <button class="btn" style="margin-top: 8px;" onclick="addToCart('${m.id}', '${m.name}', ${m.price})">Add +</button>
    </div>
  `).join('');
}

async function loadBatches() {
  const res = await (await fetch('/api/pmch/pharmacy/batches')).json();
  const body = document.getElementById('batchTableBody');
  if (!body) return;
  body.innerHTML = res.map(b => `
    <tr>
      <td>${b.medicine_name}</td>
      <td><code>${b.batch_number}</code></td>
      <td><code>${b.barcode_data || 'N/A'}</code></td>
      <td>${b.expiry_date}</td>
      <td>₹${b.unit_price}</td>
      <td>${b.current_stock}</td>
      <td><span class="badge badge-success">ACTIVE</span></td>
    </tr>
  `).join('');
}

function addToCart(id, name, price) {
  const item = cart.find(i => i.id === id);
  if (item) item.qty++; else cart.push({ id, name, price, qty: 1 });
  document.getElementById('cartCount').innerText = cart.reduce((s, i) => s + i.qty, 0);
  alert(`Added ${name} to cart!`);
}

async function loadIpdBeds() {
  const res = await (await fetch('/api/pmch/ipd/beds')).json();
  const grid = document.getElementById('ipdBedGrid');
  if (!grid) return;
  grid.innerHTML = res.map(b => `
    <div class="card" style="border-left: 4px solid ${b.status === 'VACANT' ? '#15803d' : (b.status === 'RESERVED' ? '#c69214' : '#dc2626')};">
      <div style="display: flex; justify-content: space-between;"><strong>${b.bed_id}</strong><span class="badge ${b.status === 'VACANT' ? 'badge-success' : (b.status === 'RESERVED' ? 'badge-gold' : 'badge-danger')}">${b.status}</span></div>
      <p style="margin: 4px 0;">${b.ward_type}</p>
      <small>${b.assigned_uhid ? 'Patient: ' + b.assigned_uhid : 'Vacant'}</small>
    </div>
  `).join('');
}

async function loadLimsCatalog() {
  const res = await (await fetch('/api/pmch/lims/catalog')).json();
  document.getElementById('labTestSelect').innerHTML = res.map(t => `<option value="${t.id}">${t.name} (₹${t.price})</option>`).join('');
}

async function placeLabOrder() {
  const res = await (await fetch('/api/pmch/lims/order', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uhid: getActiveUhid(), testId: document.getElementById('labTestSelect').value })
  })).json();
  alert('Lab order placed: ' + res.orderId);
  loadLimsWorklist();
}

async function loadLimsWorklist() {
  const res = await (await fetch('/api/pmch/lims/orders')).json();
  const body = document.getElementById('labWorklistBody');
  if (!body) return;
  body.innerHTML = res.map(o => `
    <tr><td><code>${o.order_id}</code></td><td>${o.uhid}</td><td>${o.test_name}</td><td>${o.result_val || '<input id="val-' + o.order_id + '" value="Normal" style="width: 80px;" />'}</td><td>${o.status === 'REPORT_PUBLISHED' ? '<span class="badge badge-success">Done</span>' : '<button class="btn btn-gold" style="padding: 2px 6px;" onclick="publishLabResult(\'' + o.order_id + '\')">Authorize</button>'}</td></tr>
  `).join('');
}

async function publishLabResult(orderId) {
  const val = document.getElementById('val-' + orderId).value;
  await fetch('/api/pmch/lims/report-result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, resultVal: val }) });
  alert('Published to EHR!');
  loadLimsWorklist();
}

async function lookupPatientEhr() {
  const uhid = document.getElementById('ehrSearchUhid')?.value?.trim() || getActiveUhid();
  const res = await (await fetch('/api/pmch/ehr/patient/' + uhid)).json();
  document.getElementById('ehrResultContainer').style.display = 'block';
  document.getElementById('ehrRecordsList').innerHTML = `
    <p><strong>ABHA ID:</strong> ${res.abha ? `<code>${res.abha.abha_number}</code> (${res.abha.abha_address})` : 'Unlinked'}</p>
    <p><strong>Appointments:</strong> ${res.appointments.length}</p>
    <p><strong>Prescriptions:</strong> ${res.prescriptions.length}</p>
    <p><strong>Pharmacy Orders:</strong> ${res.orders.length}</p>
    <p><strong>Lab Tests:</strong> ${res.labOrders.length}</p>
    <p><strong>Insurance Policy:</strong> ${res.insurance ? res.insurance.tpa_provider : 'None'}</p>
  `;
}

async function loadAdminDropdowns() {
  const meds = await (await fetch('/api/pmch/pharmacy/catalog-list')).json();
  document.getElementById('admBatchMedSelect').innerHTML = meds.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  const beds = await (await fetch('/api/pmch/ipd/beds')).json();
  document.getElementById('admAllocBedSelect').innerHTML = beds.map(b => `<option value="${b.bed_id}">${b.bed_id} (${b.ward_type})</option>`).join('');
}

async function adminAddMedicine() {
  const res = await (await fetch('/api/pmch/admin/add-medicine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('admMedName').value,
      category: document.getElementById('admMedCategory').value,
      batchNumber: document.getElementById('admMedBatch').value,
      barcode: document.getElementById('admMedBarcode').value,
      expiryDate: document.getElementById('admMedExpiry').value,
      unitPrice: document.getElementById('admMedPrice').value,
      stock: document.getElementById('admMedStock').value
    })
  })).json();
  alert(res.message);
  loadAdminDropdowns();
  loadPharmacy();
}

async function adminAddBatch() {
  const res = await (await fetch('/api/pmch/admin/add-batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      medicineId: document.getElementById('admBatchMedSelect').value,
      batchNumber: document.getElementById('admBatchNum').value,
      barcode: document.getElementById('admBatchBarcode').value,
      expiryDate: document.getElementById('admBatchExpiry').value,
      unitPrice: document.getElementById('admBatchPrice').value,
      stock: document.getElementById('admBatchStock').value
    })
  })).json();
  alert(res.message);
  loadBatches();
  loadPharmacy();
}

async function adminAddBed() {
  const res = await (await fetch('/api/pmch/admin/add-bed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bedId: document.getElementById('admBedId').value,
      wardType: document.getElementById('admBedWard').value,
      dailyRate: document.getElementById('admBedRate').value
    })
  })).json();
  alert(res.message);
  loadAdminDropdowns();
  loadIpdBeds();
}

async function adminUpdateAllocation(status) {
  const res = await (await fetch('/api/pmch/admin/update-bed-allocation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bedId: document.getElementById('admAllocBedSelect').value,
      uhid: document.getElementById('admAllocUhid').value,
      admittedAt: document.getElementById('admAllocDate').value,
      status
    })
  })).json();
  alert(res.message);
  loadAdminDropdowns();
  loadIpdBeds();
}

async function adminAddDoctor() {
  const res = await (await fetch('/api/pmch/admin/add-doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: document.getElementById('admDocName').value,
      specialty: document.getElementById('admDocSpecialty').value,
      fee: document.getElementById('admDocFee').value
    })
  })).json();
  alert(res.message);
  loadDoctors();
}

window.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('pmch_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      document.getElementById('loginOverlay').style.display = 'none';
      applyRolePermissions(currentUser);
    } catch {
      sessionStorage.removeItem('pmch_user');
    }
  }
});