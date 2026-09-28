let socket;
let currentUser = null;
let cart = [];
let lastCalculatedBill = null;

try {
  socket = io();
} catch (e) {
  console.warn('Socket connection delayed:', e);
}

// ======================== HARDENED AUDIO QUEUE CALLER ========================
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

// ======================== FEATURE 1: WEBRTC VIDEO CONSULTATION ========================
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
    alert('Camera/Microphone permission denied or device unavailable: ' + err.message);
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
  const audioTrack = localStream.getAudioTracks()[0];
  if (audioTrack) {
    audioTrack.enabled = !audioTrack.enabled;
    document.getElementById('btnToggleAudio').innerText = audioTrack.enabled ? '🎙️ Mute Mic' : '🔇 Unmute Mic';
  }
}

function toggleLocalVideo() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.enabled = !videoTrack.enabled;
    document.getElementById('btnToggleVideo').innerText = videoTrack.enabled ? '📷 Turn Off Camera' : '🎥 Turn On Camera';
  }
}

// Socket Signaling Listeners
if (socket) {
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
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
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

// ======================== FEATURE 3: LIVE UPI PAYMENT GATEWAY MODAL ========================
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
      alert('UPI transaction window expired. Please try again.');
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
  alert(`💳 UPI Payment Successful!\nBank Ref: ${txnRef}\nStatus: SETTLED & VERIFIED`);
  if (activePaymentCallback) {
    activePaymentCallback({ success: true, txnRef });
  }
}

// Integration into OPD Token Booking
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
          patientPhone: '9876543210',
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

// Integration into Central Pharmacy Checkout
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

// Integration into Final Discharge Co-Pay Settle
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
        alert(`✅ Discharge Settled!\nInvoice: ${res.billId}\nClaim: ${res.claimId || 'Direct UPI Cleared'}\nUPI Ref: ${txnRef}`);
      }
    }
  });
}

// ======================== SMART BEDSIDE WAVEFORM ENGINE ========================
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

// ======================== ABDM & ABHA SANDBOX ========================
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

// ======================== TPA INSURANCE DESK ========================
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

// ======================== BILLING & PDF DOSSIER ========================
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

// Clinical AI Co-Pilot
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

// Authentication & Navigation Handlers
function fillLogin(u, p) {
  document.getElementById('loginUsername').value = u;
  document.getElementById('loginPassword').value = p;
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;

  const res = await (await fetch('/api/pmch/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
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

function applyRolePermissions(user) {
  document.getElementById('sessionUserName').innerText = user.name;
  document.getElementById('sessionUserDept').innerText = user.department;
  document.getElementById('sessionUserRole').innerText = user.role;

  const navAdmin = document.getElementById('nav-admin');
  const navTelemed = document.getElementById('nav-telemed');
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

  if (user.role === 'ADMIN') {
    [navAdmin, navTelemed, navAbdm, navInsurance, navRx, navOpd, navPharmacy, navIpd, navLims, navBilling].forEach(el => el.style.display = 'inline-block');
    switchTab('tab-admin');
  } else if (user.role === 'DOCTOR') {
    navAdmin.style.display = 'none';
    navInsurance.style.display = 'none';
    navPharmacy.style.display = 'none';
    navBilling.style.display = 'none';
    [navOpd, navTelemed, navRx, navIpd, navLims, navAbdm].forEach(el => el.style.display = 'inline-block');
    switchTab('tab-opd');
  } else {
    navAdmin.style.display = 'none';
    navRx.style.display = 'none';
    navIpd.style.display = 'none';
    navLims.style.display = 'none';
    [navOpd, navTelemed, navPharmacy, navBilling, navInsurance, navAbdm].forEach(el => el.style.display = 'inline-block');
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
    <tr><td>${b.medicine_name}</td><td><code>${b.batch_number}</code></td><td>${b.expiry_date}</td><td>₹${b.unit_price}</td><td>${b.current_stock}</td><td><span class="badge badge-success">ACTIVE</span></td></tr>
  `).join('');
}

function addToCart(id, name, price) {
  const item = cart.find(i => i.id === id);
  if (item) item.qty++; else cart.push({ id, name, price, qty: 1 });
  document.getElementById('cartCount').innerText = cart.reduce((s, i) => s + i.qty, 0);
}

async function loadIpdBeds() {
  const res = await (await fetch('/api/pmch/ipd/beds')).json();
  const grid = document.getElementById('ipdBedGrid');
  if (!grid) return;
  grid.innerHTML = res.map(b => `
    <div class="card" style="border-left: 4px solid ${b.status === 'VACANT' ? '#15803d' : '#dc2626'};">
      <div style="display: flex; justify-content: space-between;"><strong>${b.bed_id}</strong><span class="badge ${b.status === 'VACANT' ? 'badge-success' : 'badge-danger'}">${b.status}</span></div>
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

// Admin APIs
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