// ====== Firebase / Firestore ======
// fsdb and auth are initialised in firebase-config.js (loaded before this script)

// Current session state
let currentUser = null;   // { uid, role:'admin'|'employee', empId:null|number }

// ---- Employees collection ----
const addEmployee = async emp => {
    const ref = await fsdb.collection('employees').add(emp);
    return ref.id;
};
const getAllEmployees = async () => {
    const snap = await fsdb.collection('employees').get();
    return snap.docs.map(d => ({ ...d.data(), id: d.id }));
};
const deleteEmployee = id => fsdb.collection('employees').doc(String(id)).delete();

// ---- Attendance collection ----
const logAttendance = rec => fsdb.collection('attendance').add(rec);
const getAttendance = async () => {
    let query = fsdb.collection('attendance');
    // Employees only see their own records
    if (currentUser && currentUser.role === 'employee') {
        query = query.where('employee_id', '==', currentUser.empId);
    }
    const snap = await query.get();
    const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    // Sort ascending by timestamp locally to avoid complex Firestore indexing
    docs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return docs;
};
const getLastPunch = async id => {
    // Avoid orderBy('timestamp') here to prevent Firestore Composite Index errors.
    // We fetch the employee's punches and sort them locally to find the latest.
    const snap = await fsdb.collection('attendance')
        .where('employee_id', '==', id)
        .get();

    if (snap.empty) return null;

    // Convert to array and sort descending by timestamp in memory
    const docs = snap.docs.map(d => ({ ...d.data(), id: d.id }));
    docs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return docs[0];
};
// Update a log record (used by attendance correction)
const updateAttendance = (id, data) =>
    fsdb.collection('attendance').doc(String(id)).update(data);
const deleteAttendance = id =>
    fsdb.collection('attendance').doc(String(id)).delete();

// ---- Auth ----
async function signInAdmin(email, password) {
    await auth.signInWithEmailAndPassword(email, password);
    currentUser = { uid: auth.currentUser.uid, role: 'admin', empId: null };
    localStorage.setItem('fsRole', 'admin');
}
function signInEmployee(empId) {
    currentUser = { uid: null, role: 'employee', empId: Number(empId) };
    localStorage.setItem('fsRole', 'employee');
    localStorage.setItem('fsEmpId', empId);
}
function signOut() {
    auth.signOut().catch(() => { });
    currentUser = null;
    localStorage.removeItem('fsRole');
    localStorage.removeItem('fsEmpId');
    showLoginScreen();
}
function isAdmin() { return currentUser && currentUser.role === 'admin'; }

// ---- Login screen helpers ----
function showLoginScreen() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-shell').style.display = 'none';
}
function hideLoginScreen() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-shell').style.display = 'flex';
}
async function handleAdminLogin() {
    const email = document.getElementById('login-email').value.trim();
    const pass = document.getElementById('login-pass').value;
    const btn = document.getElementById('login-admin-btn');
    if (!email || !pass) { toast('Enter email and password', 'warning'); return; }
    btn.disabled = true; btn.textContent = 'Signing in...';
    try {
        await signInAdmin(email, pass);
        await loadSettings(true); // Force-sync settings from Firestore on successful login
        hideLoginScreen();
        showSection('dashboard');
        applyRoleUI();
        toast('Welcome, Admin!', 'success');
    } catch (e) {
        toast('Login failed: ' + e.message, 'error');
    } finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}
function handleEmployeeLogin() {
    const empId = document.getElementById('login-empid').value.trim();
    if (!empId) { toast('Enter your Employee ID', 'warning'); return; }

    // Verify employee exists
    getAllEmployees().then(emps => {
        const found = emps.find(e => String(e.employee_id || '').toLowerCase() === empId.toLowerCase()
            || String(e.id).toLowerCase() === empId.toLowerCase()
            || String(e.name).toLowerCase() === empId.toLowerCase());

        if (!found) {
            toast('Employee not found \u2014 check your ID or name', 'error');
            return;
        }

        signInEmployee(found.employee_id || found.id);
        currentUser.name = found.name;
        hideLoginScreen();
        showSection('dashboard');
        applyRoleUI();
        toast('Welcome, ' + found.name + '!', 'success');
    }).catch(e => {
        console.error("Login verification failed", e);
        toast('Failed to verify ID. Please check connection.', 'error');
    });
}
function applyRoleUI() {
    const admin = isAdmin();
    // Show/hide admin-only elements
    document.querySelectorAll('.admin-only').forEach(el => el.style.display = admin ? '' : 'none');
    document.querySelectorAll('.employee-only').forEach(el => el.style.display = admin ? 'none' : '');
    // Update header badge
    const badge = document.getElementById('role-badge');
    if (badge) {
        badge.textContent = admin ? '🛡 Admin' : '👤 ' + (currentUser.name || 'Employee');
        badge.style.color = admin ? '#818cf8' : '#10b981';
    }
}

// ====== Config ======
let campusHQ = { lat: 20.5937, lng: 78.9629 };
let geofenceRadius = 500;
let shiftStart = '09:00';
let adminPin = '1234';
let overtimeHours = 9;       // hours/day before OT flag
let confidenceThresh = 0.4;  // face match distance threshold (lowered for higher precision)
let pinUnlockedUntil = 0;
let pendingSection = null;
let currentPin = '';
let allLogs = [];
let allEmployees = [];
let chart7day = null;
let chartDept = null;
let settingsListener = null; // for real-time sync

// ====== Audio Feedback ======
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
}
function playPunchSound(isIn) {
    try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = isIn ? 880 : 660;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.18, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
    } catch (e) { /* AudioContext blocked */ }
}
function speakName(name, status) {
    if (!window.speechSynthesis) return;
    const msg = new SpeechSynthesisUtterance(
        status === 'IN' ? 'Welcome, ' + name + '!' : 'Goodbye, ' + name + '!'
    );
    msg.rate = 1.1; msg.pitch = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(msg);
}

// ====== Toast ======
function toast(msg, type = 'info', duration = 4000) {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    t.innerHTML = `<span style="font-size:16px">${icons[type] || ''}</span><span>${msg}</span>`;
    c.appendChild(t);
    setTimeout(() => {
        t.style.transition = 'opacity .3s, transform .3s';
        t.style.opacity = '0';
        t.style.transform = 'translateX(40px)';
        setTimeout(() => t.remove(), 300);
    }, duration);
}

// ====== Settings ======
// ====== Settings ======
async function loadSettings(forceRestart = false) {
    console.log("🔄 Initializing Settings Sync... (Force: " + forceRestart + ")");
    updateSettingsUI('initializing');
    if (forceRestart && settingsListener) {
        settingsListener(); // Unsubscribe existing listener
        settingsListener = null;
    }
    // 1. Load from Local Storage first as a fast fallback
    const local = localStorage.getItem('fsSett');
    if (local) {
        try {
            const c = JSON.parse(local);
            campusHQ = c.campusHQ || campusHQ;
            geofenceRadius = c.geofenceRadius || 500;
            shiftStart = c.shiftStart || '09:00';
            adminPin = c.adminPin || '1234';
            overtimeHours = c.overtimeHours || 9;
            confidenceThresh = c.confidenceThresh || 0.4;
            console.log("✅ Local settings loaded:", adminPin);
        } catch(e) { console.warn("Stale local cache", e); }
    }

    // 2. Initial Fetch from Firestore
    try {
        const initialDoc = await fsdb.collection('settings').doc('global').get();
        if (initialDoc.exists) {
            const c = initialDoc.data();
            applySettingsObject(c);
            console.log("☁️ Initial cloud settings fetched:", adminPin);
        }
    } catch (e) { 
        console.warn("Cloud fetch pending authentication or disconnected", e.message); 
    }

    // 3. Setup Persistent Real-time Listener (if not already running)
    if (!settingsListener) {
        settingsListener = fsdb.collection('settings').doc('global').onSnapshot(doc => {
            if (doc.exists) {
                const c = doc.data();
                applySettingsObject(c);
                console.log("⚡ Real-time settings update received:", adminPin);
                updateSettingsUI(true);
            }
        }, e => {
            console.error("❌ Sync Error:", e.code, e.message);
            if (e.code === 'permission-denied') {
                updateSettingsUI('denied');
                toast('Access Denied: Please check Firestore rules in Console', 'error', 8000);
            } else {
                updateSettingsUI(false);
            }
            // Auto-retry listener if it dies (e.g. network change) with a small delay
            settingsListener = null; 
            setTimeout(() => { if (!settingsListener) loadSettings(); }, 5000);
        });
    }

    updateSettingsUI();
}

function applySettingsObject(c) {
    if (!c) return;
    campusHQ = c.campusHQ || campusHQ;
    geofenceRadius = c.geofenceRadius || 500;
    shiftStart = c.shiftStart || '09:00';
    adminPin = String(c.adminPin || '1234').trim();
    overtimeHours = c.overtimeHours || 9;
    confidenceThresh = c.confidenceThresh || 0.4;
    localStorage.setItem('fsSett', JSON.stringify({ campusHQ, geofenceRadius, shiftStart, adminPin, overtimeHours, confidenceThresh }));
}

function updateSettingsUI(isSynced = null) {
    const hl = document.getElementById('hq-lat'); if (hl) hl.value = (campusHQ.lat || 0);
    const hln = document.getElementById('hq-lng'); if (hln) hln.value = (campusHQ.lng || 0);
    const fr = document.getElementById('fence-radius'); if (fr) fr.value = geofenceRadius;
    const st = document.getElementById('shift-time'); if (st) st.value = shiftStart;
    const ap = document.getElementById('admin-pin'); if (ap) ap.value = adminPin;
    const ll = document.getElementById('light-level');
    if (ll) ll.value = localStorage.getItem('lightLevel') || '2';
    const oth = document.getElementById('ot-hours');
    if (oth) oth.value = overtimeHours;
    const conf = document.getElementById('conf-thresh');
    if (conf) { conf.value = confidenceThresh; document.getElementById('conf-val').textContent = confidenceThresh; }

    // Sync status indicator
    const syncStatus = document.getElementById('sync-status');
    if (syncStatus) {
        if (isSynced === true) {
            syncStatus.innerHTML = '<span style="color:#10b981">● Cloud Connected</span>';
            console.log("PIN Synced: " + adminPin);
        } else if (isSynced === 'denied') {
            syncStatus.innerHTML = '<span style="color:#f43f5e">● Access Denied (Check Rules)</span>';
        } else if (isSynced === false) {
            syncStatus.innerHTML = '<span style="color:#f59e0b">● Reconnecting...</span>';
        } else if (isSynced === 'initializing') {
            syncStatus.innerHTML = '<span style="color:#818cf8">● Initializing Sync...</span>';
        } else {
            syncStatus.innerHTML = '<span style="color:#64748b">● Local Cache Only</span>';
        }
    }
    
    // Apply saved theme
    const theme = localStorage.getItem('theme') || 'dark';
    document.body.setAttribute('data-theme', theme);
    const icon = document.getElementById('theme-icon');
    if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
}
async function saveSettings() {
    campusHQ = {
        lat: parseFloat(document.getElementById('hq-lat').value) || campusHQ.lat,
        lng: parseFloat(document.getElementById('hq-lng').value) || campusHQ.lng
    };
    geofenceRadius = parseInt(document.getElementById('fence-radius').value) || 500;
    shiftStart = document.getElementById('shift-time').value || '09:00';
    adminPin = (document.getElementById('admin-pin').value || '1234').trim();
    overtimeHours = parseFloat(document.getElementById('ot-hours').value) || 9;
    confidenceThresh = parseFloat(document.getElementById('conf-thresh').value) || 0.4;
    const ll = document.getElementById('light-level');
    if (ll) localStorage.setItem('lightLevel', ll.value);
    
    const config = { campusHQ, geofenceRadius, shiftStart, adminPin, overtimeHours, confidenceThresh };
    
    // Save to local cache
    localStorage.setItem('fsSett', JSON.stringify(config));
    
    // 3. Sync to Firestore
    try {
        await fsdb.collection('settings').doc('global').set(config, { merge: true });
        toast('Settings synced across devices!', 'success');
    } catch (e) {
        toast('Sync failed: ' + e.message, 'error');
    }

    buildMatcher();
    showSection('dashboard');
}
function toggleTheme() {
    const current = document.body.getAttribute('data-theme') || 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    const icon = document.getElementById('theme-icon');
    if (icon) icon.textContent = next === 'dark' ? '☀️' : '🌙';
    toast('Switched to ' + next + ' mode', 'info', 2000);
}
async function detectLocation() {
    try {
        const loc = await getCurrentLocation();
        document.getElementById('hq-lat').value = loc.lat.toFixed(6);
        document.getElementById('hq-lng').value = loc.lng.toFixed(6);
        toast('Location detected: ' + loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4), 'success');
    } catch { toast('Location access denied', 'error'); }
}

// ====== PIN ======
function requirePin(section) {
    if (Date.now() < pinUnlockedUntil) { showSection(section); return; }
    pendingSection = section;
    currentPin = '';
    updatePinDots();
    document.getElementById('pin-modal').classList.add('open');
}
function closePinModal() {
    document.getElementById('pin-modal').classList.remove('open');
    currentPin = '';
    updatePinDots();
}
function pinKey(n) {
    if (currentPin.length >= 4) return;
    currentPin += n;
    updatePinDots();
    if (currentPin.length === 4) {
        setTimeout(() => {
            if (currentPin === adminPin) {
                pinUnlockedUntil = Date.now() + 15 * 60 * 1000;
                closePinModal();
                showSection(pendingSection);
                toast('Admin unlocked for 15 minutes', 'success');
            } else {
                toast('Incorrect PIN', 'error');
                currentPin = '';
                updatePinDots();
            }
        }, 200);
    }
}
function pinClear() { currentPin = currentPin.slice(0, -1); updatePinDots(); }
function updatePinDots() {
    for (let i = 0; i < 4; i++) {
        document.getElementById('d' + i).classList.toggle('filled', i < currentPin.length);
    }
}

// ====== Geolocation ======
const getCurrentLocation = () => new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('Geolocation not supported'));
    navigator.geolocation.getCurrentPosition(
        p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
        rej,
        { enableHighAccuracy: true, timeout: 10000 }
    );
});
const haversine = (la1, lo1, la2, lo2) => {
    const R = 6371e3, p1 = la1 * Math.PI / 180, p2 = la2 * Math.PI / 180;
    const dp = (la2 - la1) * Math.PI / 180, dl = (lo2 - lo1) * Math.PI / 180;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ====== AI Engine ======
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights';
let isAIReady = false, faceMatcher = null, videoStream = null, rafId = null;
let kioskRunning = false;
let gpsIntervalId = null;
const processingSet = new Set();
const punchCooldown = new Map();
let isKioskShuttingDown = false; // session lock for single-punch logic

// ====== Liveness Detection ======
// livenessState per employee: { state:'idle'|'waiting'|'confirmed', ear:[], timer:null }
const livenessMap = new Map();
const EAR_BLINK_THRESH = 0.26;  // below this = eye closed (raised for better sensitivity)
const EAR_CONSEC_FRAMES = 1;    // frames eye must stay closed to count as blink (1 frame is better for slow webcams)

function computeEAR(eye) {
    // eye = array of 6 {x,y} landmark points
    // EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return (dist(eye[1], eye[5]) + dist(eye[2], eye[4])) / (2 * dist(eye[0], eye[3]));
}

function getLivenessState(name) {
    if (!livenessMap.has(name)) livenessMap.set(name, { state: 'idle', consecutive: 0, timer: null });
    return livenessMap.get(name);
}

function startLivenessCheck(name) {
    const ls = getLivenessState(name);
    if (ls.state !== 'idle') return;  // already checking
    ls.state = 'waiting';
    ls.consecutive = 0;
    const prompt = document.getElementById('liveness-prompt');
    if (prompt) { prompt.style.display = 'block'; prompt.textContent = '👁 Please blink to verify — ' + name; }
    ls.timer = setTimeout(() => {
        const cur = getLivenessState(name);
        if (cur.state === 'waiting' && !isKioskShuttingDown) {
            cur.state = 'idle';
            punchCooldown.delete(name);  // allow retry
            if (prompt) prompt.style.display = 'none';
            toast(name + ': Liveness timeout — please blink and try again', 'warning', 5000);
        }
    }, 5000);
}

function checkLivenessFrame(name, landmarks) {
    const ls = getLivenessState(name);
    if (ls.state !== 'waiting') return ls.state;
    // landmarks is a FaceLandmarks68; points 36-41 left eye, 42-47 right eye
    const lm = landmarks.positions;
    const leftEye = lm.slice(36, 42);
    const rightEye = lm.slice(42, 48);
    const ear = (computeEAR(leftEye) + computeEAR(rightEye)) / 2;
    if (ear < EAR_BLINK_THRESH) {
        ls.consecutive++;
        if (ls.consecutive >= EAR_CONSEC_FRAMES) {
            ls.state = 'confirmed';
            clearTimeout(ls.timer);
            const prompt = document.getElementById('liveness-prompt');
            if (prompt) prompt.style.display = 'none';
            // Reset after 15s so same person can punch again later
            setTimeout(() => ls.state = 'idle', 15000);
        }
    } else {
        ls.consecutive = 0;
    }
    return ls.state;
}

// ====== Low-Light Enhancement ======
const enhanceCanvas = document.createElement('canvas');
const enhanceCtx = enhanceCanvas.getContext('2d');
const ENHANCE_FILTERS = [
    '',                                           // 0 = Off
    'brightness(1.25) contrast(1.1)',              // 1 = Low
    'brightness(1.5) contrast(1.2)',               // 2 = Medium
    'brightness(1.85) contrast(1.35) saturate(1.1)' // 3 = High
];

function enhanceFrame(video) {
    const level = parseInt(localStorage.getItem('lightLevel') || '2');
    enhanceCanvas.width = video.videoWidth;
    enhanceCanvas.height = video.videoHeight;
    enhanceCtx.filter = ENHANCE_FILTERS[level] || '';
    enhanceCtx.drawImage(video, 0, 0);
    enhanceCtx.filter = 'none';
    return enhanceCanvas;
}

async function loadModels() {
    try {
        await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
        await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
        await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
        isAIReady = true;
        document.getElementById('ai-dot').style.background = '#10b981';
        document.getElementById('ai-text').textContent = 'SSD MobileNet Ready';
        toast('AI engine loaded', 'success');
        await buildMatcher();
    } catch (e) {
        document.getElementById('ai-dot').style.background = '#f43f5e';
        document.getElementById('ai-text').textContent = 'AI Load Failed';
        toast('AI failed: ' + e.message, 'error');
    }
}
async function buildMatcher() {
    const emps = await getAllEmployees();
    allEmployees = emps;
    if (!emps.length) { faceMatcher = null; return; }
    const ld = emps.map(e => new faceapi.LabeledFaceDescriptors(e.name, [new Float32Array(e.descriptor)]));
    faceMatcher = new faceapi.FaceMatcher(ld, confidenceThresh);
}

// ====== Attendance Logic ======
async function handleAttendance(name, landmarks) {
    if (isKioskShuttingDown) return;
    const now = Date.now();
    const lastPunch = punchCooldown.get(name) || 0;
    // Liveness gate: bypass strict blink requirement for speed
    const ls = getLivenessState(name);
    if (ls.state === 'idle') { startLivenessCheck(name); }
    if (landmarks) checkLivenessFrame(name, landmarks);

    // CRITICAL: Stop the kiosk immediately to prevent double-punches
    // while we process the rest of the attendance logic.
    isKioskShuttingDown = true;
    stopKiosk();

    // Show processing indicator
    const prompt = document.getElementById('liveness-prompt');
    if (prompt) { 
        prompt.style.display = 'block'; 
        prompt.textContent = '🔄 Syncing attendance for ' + name + '...'; 
        prompt.style.background = 'rgba(99,102,241,0.9)';
    }

    processingSet.add(name);
    punchCooldown.set(name, now);
    const emp = allEmployees.find(e => e.name === name);
    if (!emp) { processingSet.delete(name); return; }
    try {
        const loc = await getCurrentLocation();
        const dist = haversine(loc.lat, loc.lng, campusHQ.lat, campusHQ.lng);
        if (dist > geofenceRadius) {
            toast('GEOFENCE: ' + Math.round(dist) + 'm away (max ' + geofenceRadius + 'm)', 'error', 6000);
            isKioskShuttingDown = false; // Reset to allow retry
            return;
        }
        const last = await getLastPunch(emp.id);
        const status = (!last || last.status === 'OUT') ? 'IN' : 'OUT';
        const ts = new Date().toISOString();
        const isLate = status === 'IN' && isAfterShift(ts);
        await logAttendance({
            employee_id: emp.id, name: emp.name, timestamp: ts, status,
            location: loc.lat.toFixed(4) + ',' + loc.lng.toFixed(4), late: isLate
        });
        showScanResult(emp.name, status, isLate, loc.lat.toFixed(4) + ', ' + loc.lng.toFixed(4));
        refreshDashboard();
        toast(emp.name + ' punched ' + status + (isLate ? ' (Late)' : ''), 'success');
        playPunchSound(status === 'IN');
        speakName(emp.name, status);

    } catch (e) {
        toast('Attendance failed: ' + e.message, 'error');
        punchCooldown.delete(name);
        isKioskShuttingDown = false; // Reset block on error
    } finally {
        processingSet.delete(name);
        const prompt = document.getElementById('liveness-prompt');
        if (prompt) prompt.style.display = 'none';
    }
}
function isAfterShift(ts) {
    if (!shiftStart) return false;
    const d = new Date(ts), [sh, sm] = shiftStart.split(':').map(Number);
    return d.getHours() > sh || (d.getHours() === sh && d.getMinutes() > sm);
}
function showScanResult(name, status, late, coords) {
    const el = document.getElementById('scan-result');
    const isIn = status === 'IN';
    el.style.display = 'block';
    el.innerHTML = `
        <div style="font-size:22px;font-weight:800;color:${isIn ? '#10b981' : '#f59e0b'}">${isIn ? '✅' : '👋'} Punched ${status}${late ? ' — <span style="color:#f43f5e">Late Arrival</span>' : ''}</div>
        <div style="font-weight:600;color:#e2e8f0;margin-top:6px;font-size:18px">${name}</div>
        <div style="font-size:12px;color:#475569;margin-top:4px">📍 ${coords}</div>`;
    setTimeout(() => el.style.display = 'none', 8000);
}

// ====== Kiosk ======
async function startKiosk() {
    if (!isAIReady) { toast('AI still loading, please wait', 'warning'); return; }
    if (kioskRunning) { toast('Kiosk already running', 'info'); return; }  // prevent double-start
    try {
        videoStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        });
        const v = document.getElementById('video');
        v.srcObject = videoStream;
        document.getElementById('vid-placeholder').style.display = 'none';
        kioskRunning = true;
        isKioskShuttingDown = false;
        v.onloadedmetadata = () => { v.play(); runDetect(); };
        // Clear any old GPS interval before starting a new one
        if (gpsIntervalId) clearInterval(gpsIntervalId);
        updateGPS();
        gpsIntervalId = setInterval(updateGPS, 20000);
    } catch (e) { toast('Camera error: ' + e.message, 'error'); }
}
function stopKiosk() {
    kioskRunning = false;  // signal the async RAF loop to stop re-enqueuing
    if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (gpsIntervalId) { clearInterval(gpsIntervalId); gpsIntervalId = null; }
    document.getElementById('vid-placeholder').style.display = 'flex';
    // Clear canvas
    const c = document.getElementById('overlay');
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
async function runDetect() {
    if (!kioskRunning) return;
    const v = document.getElementById('video'), c = document.getElementById('overlay');
    if (!v.videoWidth || !v.videoHeight) { rafId = requestAnimationFrame(runDetect); return; }
    if (!faceMatcher) { rafId = requestAnimationFrame(runDetect); return; }
    c.width = v.videoWidth; c.height = v.videoHeight;
    try {
        // Run detection on brightness-enhanced frame for low-light accuracy
        const source = enhanceFrame(v);
        const dets = await faceapi.detectAllFaces(source, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
            .withFaceLandmarks().withFaceDescriptors();
        
        if (!kioskRunning || isKioskShuttingDown) return;
        
        const ctx = c.getContext('2d');
        // Draw the enhanced frame onto the visible overlay canvas
        ctx.drawImage(source, 0, 0, c.width, c.height);

        for (const d of dets) {
            const m = faceMatcher.findBestMatch(d.descriptor);
            const b = d.detection.box, known = m.label !== 'unknown';
            
            // Box colour: green=confirmed, red=unknown
            ctx.strokeStyle = known ? '#10b981' : '#f43f5e';
            ctx.lineWidth = 2;
            ctx.strokeRect(b.x, b.y, b.width, b.height);
            
            ctx.fillStyle = known ? 'rgba(16,185,129,.8)' : 'rgba(244,63,94,.8)';
            ctx.fillRect(b.x, b.y - 26, b.width, 26);
            ctx.fillStyle = '#fff'; ctx.font = 'bold 12px Inter';
            const label = m.label + (known ? ' ✓' : ' ?');
            ctx.fillText(label, b.x + 5, b.y - 9);

            if (known && !isKioskShuttingDown) {
                handleAttendance(m.label, d.landmarks);
                break; // Stop processing further faces once we've found a match
            }
        }
    } catch (e) {
        if (!kioskRunning) return;
    }
    if (kioskRunning && !isKioskShuttingDown) {
        rafId = requestAnimationFrame(runDetect);
    }
}
async function handleImageUpload(e) {
    if (!isAIReady) { toast('AI still loading', 'warning'); return; }
    const file = e.target.files[0]; if (!file) return;
    const img = await faceapi.bufferToImage(file);
    const det = await faceapi.detectSingleFace(img, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
        .withFaceLandmarks().withFaceDescriptor();
    if (!det) { toast('No face detected in image', 'error'); return; }
    if (!faceMatcher) { toast('No employees enrolled yet', 'warning'); return; }
    const m = faceMatcher.findBestMatch(det.descriptor);
    if (m.label !== 'unknown') await handleAttendance(m.label);
    else toast('Face not recognized', 'error');
}
async function updateGPS() {
    try {
        const l = await getCurrentLocation();
        document.getElementById('gps-text').textContent = 'GPS: ' + l.lat.toFixed(4) + ', ' + l.lng.toFixed(4);
    } catch { document.getElementById('gps-text').textContent = 'GPS: Off'; }
}

// ====== Registration ======
let enrollCameraStream = null;
let enrollSnapBlob = null;  // holds the captured webcam photo as a Blob

function switchEnrollTab(tab) {
    document.getElementById('tab-upload').classList.toggle('active', tab === 'upload');
    document.getElementById('tab-camera').classList.toggle('active', tab === 'camera');
    document.getElementById('enroll-upload-area').style.display = tab === 'upload' ? '' : 'none';
    document.getElementById('enroll-camera-area').style.display = tab === 'camera' ? '' : 'none';
    enrollSnapBlob = null;
    document.getElementById('enroll-snap-preview').style.display = 'none';
    if (tab === 'camera') {
        // Start enrollment camera stream
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } } })
            .then(s => {
                enrollCameraStream = s;
                document.getElementById('enroll-video').srcObject = s;
                document.getElementById('enroll-video').play();
            })
            .catch(e => toast('Camera error: ' + e.message, 'error'));
    } else {
        // Stop enrollment camera stream when switching away
        if (enrollCameraStream) { enrollCameraStream.getTracks().forEach(t => t.stop()); enrollCameraStream = null; }
    }
}

async function captureEnrollSnap() {
    if (!isAIReady) { toast('AI is still loading, please wait.', 'warning'); return; }
    const video = document.getElementById('enroll-video');
    if (!video.videoWidth) { toast('Camera not ready yet', 'warning'); return; }

    // Validate that a human face is actually in the frame
    const btn = document.querySelector('button[onclick="captureEnrollSnap()"]');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Verifying face...';

    try {
        const det = await faceapi.detectSingleFace(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }));
        if (!det) {
            toast('No human face detected! Please position your face inside the oval.', 'error', 4000);
            btn.disabled = false;
            btn.textContent = oldText;
            return; // reject capture
        }

        const canvas = document.getElementById('enroll-snap-canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        // When drawing mirrored video to canvas, we need to flip the context horizontally
        const ctx = canvas.getContext('2d');
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, 0, 0);

        canvas.toBlob(blob => {
            enrollSnapBlob = blob;
            const url = URL.createObjectURL(blob);
            document.getElementById('snap-img').src = url;
            document.getElementById('enroll-snap-preview').style.display = 'block';
            toast('Face captured securely! Click Enroll Now to continue.', 'success');
            btn.disabled = false;
            btn.textContent = oldText;
        }, 'image/jpeg', 0.92);

    } catch (e) {
        console.error("Face validation error", e);
        toast('Error validating face capture', 'error');
        btn.disabled = false;
        btn.textContent = oldText;
    }
}

function toggleRegModal(show) {
    document.getElementById('reg-modal').classList.toggle('open', show);
    if (!show) {
        document.getElementById('reg-form').reset();
        document.getElementById('photo-preview').style.display = 'none';
        document.getElementById('enroll-snap-preview').style.display = 'none';
        enrollSnapBlob = null;
        // Stop enrollment camera if open
        if (enrollCameraStream) { enrollCameraStream.getTracks().forEach(t => t.stop()); enrollCameraStream = null; }
        // Always revert to upload tab
        switchEnrollTab('upload');
    }
}
function previewPhoto(e) {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = ev => {
        document.getElementById('preview-img').src = ev.target.result;
        document.getElementById('photo-preview').style.display = 'block';
    };
    r.readAsDataURL(f);
}
async function handleRegistration(e) {
    e.preventDefault();
    if (!isAIReady) { toast('AI not ready', 'warning'); return; }
    const fd = new FormData(e.target);
    const status = document.getElementById('enroll-status');
    const msg = document.getElementById('enroll-msg');
    status.style.display = 'block'; msg.textContent = 'Decoding image...';
    try {
        // Determine image source: webcam snap or file upload
        let imageSource;
        const activeTab = document.getElementById('tab-camera').classList.contains('active') ? 'camera' : 'upload';
        if (activeTab === 'camera') {
            if (!enrollSnapBlob) throw new Error('Please capture a photo first using the camera tab.');
            imageSource = await faceapi.bufferToImage(enrollSnapBlob);
        } else {
            const file = fd.get('image');
            if (!file || !file.size) throw new Error('Please select a photo file.');
            imageSource = await faceapi.bufferToImage(file);
        }
        msg.textContent = 'Detecting face...';
        await new Promise(r => requestAnimationFrame(r));
        const det = await faceapi.detectSingleFace(imageSource, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
            .withFaceLandmarks().withFaceDescriptor();
        if (!det) throw new Error('No clear face found. Ensure good lighting and a front-facing photo.');
        msg.textContent = 'Saving profile...';
        const name = fd.get('name');
        await addEmployee({
            name, role: fd.get('role'), department: fd.get('department'),
            descriptor: Array.from(det.descriptor),
            initials: name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        });
        await buildMatcher();
        status.style.display = 'none';
        toggleRegModal(false);
        toast(name + ' enrolled successfully!', 'success');
        if (document.getElementById('employees').classList.contains('active')) refreshEmployees();
        refreshDashboard();
    } catch (err) {
        status.style.display = 'none';
        toast('Enrollment failed: ' + err.message, 'error');
    }
}

// ====== Session Builder (dedup + pair IN/OUT) ======
function buildSessions(logs) {
    const deduped = [];
    logs.forEach(log => {
        const last = deduped.filter(l => l.employee_id === log.employee_id && l.status === log.status).pop();
        if (!last || Math.abs(new Date(log.timestamp) - new Date(last.timestamp)) > 60000) deduped.push(log);
    });
    deduped.sort((a, b) => a.employee_id - b.employee_id || new Date(a.timestamp) - new Date(b.timestamp));
    const pad = n => String(n).padStart(2, '0');
    const fmt = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
    const fmtD = ts => { const d = new Date(ts); return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear(); };
    const sessions = [], pending = {};
    deduped.forEach(log => {
        const k = log.employee_id + '_' + fmtD(log.timestamp);
        if (log.status === 'IN') {
            pending[k] = log;
        } else if (log.status === 'OUT') {
            const inR = pending[k];
            if (inR) {
                const ms = new Date(log.timestamp) - new Date(inR.timestamp);
                const hrs = ms / 3600000;
                const ot = hrs > overtimeHours;
                sessions.push({ name: log.name, empId: log.employee_id, logId: log.id, dept: log.department || '', date: fmtD(log.timestamp), punchIn: fmt(inR.timestamp), punchOut: fmt(log.timestamp), dur: Math.floor(hrs) + 'h ' + Math.floor(ms % 3600000 / 60000) + 'm', status: 'OUT', late: inR.late, ot, loc: log.location || 'N/A' });
                delete pending[k];
            } else {
                sessions.push({ name: log.name, empId: log.employee_id, logId: log.id, dept: log.department || '', date: fmtD(log.timestamp), punchIn: '—', punchOut: fmt(log.timestamp), dur: '—', status: 'OUT', late: false, ot: false, loc: log.location || 'N/A' });
            }
        }
    });
    Object.values(pending).forEach(log => {
        const d = new Date(log.timestamp), p = n => String(n).padStart(2, '0');
        sessions.push({ name: log.name, empId: log.employee_id, logId: log.id, dept: log.department || '', date: p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear(), punchIn: p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()), punchOut: '—', dur: 'Active', status: 'IN', late: log.late, ot: false, loc: log.location || 'N/A' });
    });
    return sessions;
}

// ====== Dashboard ======
async function refreshDashboard() {
    const [emps, logs] = await Promise.all([getAllEmployees(), getAttendance()]);
    allEmployees = emps; allLogs = logs;
    const today = new Date().toDateString();
    const todayLogs = logs.filter(l => new Date(l.timestamp).toDateString() === today);
    const uniqueToday = new Set(todayLogs.map(l => l.employee_id));
    const lateToday = new Set(todayLogs.filter(l => l.status === 'IN' && l.late).map(l => l.employee_id));
    const todaySessions = buildSessions(todayLogs);
    const otToday = todaySessions.filter(s => s.ot).length;
    document.getElementById('s-total').textContent = emps.length;
    document.getElementById('s-present').textContent = uniqueToday.size;
    document.getElementById('s-rate').textContent = emps.length ? Math.round(uniqueToday.size / emps.length * 100) + '%' : '0%';
    document.getElementById('s-late').textContent = lateToday.size;
    const otEl = document.getElementById('s-ot');
    if (otEl) otEl.textContent = otToday;
    renderLogTable(logs);
}

let currentSessions = [];
let _editLogIds = [];   // parallel array: index → logId for edit button

function renderLogTable(logs) {
    currentSessions = buildSessions(logs);
    filterLogs();
}

function filterLogs() {
    const q = (document.getElementById('log-search').value || '').toLowerCase();
    const filtered = q
        ? currentSessions.filter(s => s.name.toLowerCase().includes(q))
        : currentSessions;
    const tbody = document.getElementById('log-table');
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:32px;color:#475569">No records found</td></tr>';
        return;
    }
    const rows = filtered.slice().reverse().slice(0, 25);
    _editLogIds = rows.map(s => s.logId);   // store log IDs by row index
    tbody.innerHTML = rows.map(function (s, idx) {
        var editBtn = (_editLogIds[idx] != null)
            ? '<button onclick="window.editLog(' + idx + ')" style="background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.2);color:#818cf8;border-radius:7px;padding:3px 9px;cursor:pointer;font-size:11px;font-weight:700">✏️ Edit</button>'
            : '<span style="color:#334155;font-size:11px">Active</span>';
        var otBadge = s.ot ? '<span class="badge badge-ot" style="margin-left:4px">OT</span>' : '';
        var lateBadge = s.late ? '<span class="badge badge-late" style="margin-left:4px">Late</span>' : '';
        return '<tr>'
            + '<td><b style="color:#e2e8f0">' + s.name + '</b><br><span style="font-size:11px;color:#475569">ID-' + String(s.empId).padStart(4, '0') + '</span></td>'
            + '<td style="color:#64748b;font-size:13px">' + s.date + '</td>'
            + '<td style="color:#10b981;font-weight:700">' + s.punchIn + '</td>'
            + '<td style="color:#f59e0b;font-weight:700">' + s.punchOut + '</td>'
            + '<td style="color:#64748b">' + s.dur + '</td>'
            + '<td><span class="badge ' + (s.status === 'IN' ? 'badge-in' : 'badge-out') + '">' + s.status + '</span>' + lateBadge + otBadge + '</td>'
            + '<td style="color:#475569;font-size:12px">' + s.loc + '</td>'
            + '<td>' + editBtn + '</td>'
            + '</tr>';
    }).join('');
}

// Global edit entry — called by onclick="window.editLog(idx)"
window.editLog = function (idx) {
    var logId = _editLogIds[idx];
    console.log('[Edit] idx=' + idx + ' logId=' + logId);
    if (logId == null || isNaN(Number(logId))) {
        toast('Cannot edit this record (no ID)', 'warning');
        return;
    }
    openCorrectModal(Number(logId));
};

// ====== Employee Section ======
let activeDept = 'All';
async function refreshEmployees() {
    const emps = await getAllEmployees();
    allEmployees = emps;
    const depts = ['All', ...new Set(emps.map(e => e.department).filter(Boolean))];
    document.getElementById('dept-filter').innerHTML = depts.map(d =>
        `<button class="dept-tab${d === activeDept ? ' active' : ''}" onclick="setDept('${d}')">${d}</button>`
    ).join('');
    const logs = await getAttendance();
    const hours = {};
    buildSessions(logs).forEach(s => {
        if (s.dur && s.dur !== '—' && s.dur !== 'Active') {
            const parts = s.dur.match(/(\d+)h (\d+)m/);
            if (parts) hours[s.empId] = (hours[s.empId] || 0) + parseInt(parts[1]) + parseInt(parts[2]) / 60;
        }
    });
    const filtered = activeDept === 'All' ? emps : emps.filter(e => e.department === activeDept);
    const grid = document.getElementById('emp-grid');
    if (!filtered.length) {
        grid.innerHTML = '<div style="color:#475569;padding:40px;text-align:center;grid-column:1/-1">No employees enrolled yet</div>';
        return;
    }
    grid.innerHTML = filtered.map(emp => `
        <div class="employee-card">
            <div class="emp-actions admin-only">
                <button class="icon-btn edit" onclick="openEditEmpModal('${emp.id}')" title="Edit Employee">✏️</button>
                <button class="icon-btn delete" onclick="confirmDelete('${emp.id}', '${emp.name.replace(/'/g, "\\'")}')" title="Delete Employee">🗑️</button>
            </div>
            <div class="emp-avatar">${emp.initials || emp.name[0]}</div>
            <div style="font-weight:700;font-size:15px;color:#e2e8f0;margin-bottom:4px">${emp.name}</div>
            <div style="font-size:13px;color:#64748b;margin-bottom:10px">${emp.role || 'N/A'}</div>
            <span class="chip">${emp.department || 'General'}</span>
            <div style="margin-top:10px;font-size:12px;color:#22d3ee;font-weight:600">${(hours[emp.id] || 0).toFixed(1)} hrs total</div>
        </div>`).join('');
    applyRoleUI(); // hide admin buttons if not admin
}

// Edit Employee handling
function openEditEmpModal(id) {
    if (!isAdmin()) { toast('Admin access required', 'error'); return; }
    const emp = allEmployees.find(e => String(e.id) === String(id));
    if (!emp) return;
    document.getElementById('edit-emp-id').value = emp.id;
    document.getElementById('edit-emp-name').value = emp.name || '';
    document.getElementById('edit-emp-role').value = emp.role || '';
    document.getElementById('edit-emp-dept').value = emp.department || '';
    document.getElementById('edit-emp-modal').classList.add('open');
}

function closeEditEmpModal() {
    document.getElementById('edit-emp-modal').classList.remove('open');
}

async function saveEmployeeEdit() {
    if (!isAdmin()) return;
    const id = document.getElementById('edit-emp-id').value;
    const name = document.getElementById('edit-emp-name').value.trim();
    if (!id || !name) { toast('Name is required', 'warning'); return; }
    try {
        await fsdb.collection('employees').doc(String(id)).update({
            name,
            role: document.getElementById('edit-emp-role').value.trim(),
            department: document.getElementById('edit-emp-dept').value.trim(),
            initials: name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
        });
        closeEditEmpModal();
        toast('Employee details updated', 'success');
        refreshEmployees();
        buildMatcher(); // Rebuild matcher because name might be used as label
    } catch (e) {
        toast('Failed to update: ' + e.message, 'error');
    }
}
function setDept(d) { activeDept = d; refreshEmployees(); }
async function confirmDelete(id, name) {
    if (!confirm('Delete ' + name + '? This cannot be undone.')) return;
    await deleteEmployee(id);
    await buildMatcher();
    toast(name + ' removed from system', 'info');
    refreshEmployees();
    refreshDashboard();
}

// ====== Analytics ======
async function refreshAnalytics() {
    const [logs, emps] = await Promise.all([getAttendance(), getAllEmployees()]);
    const labels7 = [], data7 = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toDateString();
        labels7.push(d.toLocaleDateString('en', { weekday: 'short', day: 'numeric' }));
        data7.push(new Set(logs.filter(l => new Date(l.timestamp).toDateString() === ds).map(l => l.employee_id)).size);
    }
    if (chart7day) chart7day.destroy();
    chart7day = new Chart(document.getElementById('chart-7day'), {
        type: 'bar',
        data: {
            labels: labels7,
            datasets: [{ label: 'Present', data: data7, backgroundColor: 'rgba(99,102,241,.6)', borderColor: '#6366f1', borderWidth: 2, borderRadius: 8 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#64748b', stepSize: 1 } },
                x: { grid: { display: false }, ticks: { color: '#64748b' } }
            }
        }
    });
    const depts = [...new Set(emps.map(e => e.department).filter(Boolean))];
    const deptCounts = depts.map(dept => emps.filter(e => e.department === dept).length);
    const colors = ['rgba(99,102,241,.8)', 'rgba(16,185,129,.8)', 'rgba(245,158,11,.8)', 'rgba(244,63,94,.8)', 'rgba(34,211,238,.8)', 'rgba(168,85,247,.8)'];
    if (chartDept) chartDept.destroy();
    chartDept = new Chart(document.getElementById('chart-dept'), {
        type: 'doughnut',
        data: {
            labels: depts.length ? depts : ['No Data'],
            datasets: [{ data: depts.length ? deptCounts : [1], backgroundColor: depts.length ? colors : ['rgba(255,255,255,.05)'], borderWidth: 0 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: '#64748b', padding: 16, font: { size: 12 } } } }
        }
    });
    // Render monthly heatmap calendar
    renderHeatmap(logs);
}

// ====== Exports ======
async function downloadCSV() {
    const logs = await getAttendance();
    if (!logs.length) { toast('No logs to export', 'warning'); return; }
    const sessions = buildSessions(logs);
    const header = '#,Employee,Emp ID,Date,Punch In,Punch Out,Duration,Late,Location\n';
    const rows = sessions.map((s, i) =>
        `${i + 1},"${s.name}",ID-${String(s.empId).padStart(4, '0')},${s.date},${s.punchIn},${s.punchOut},${s.dur},${s.late ? 'Yes' : 'No'},"${s.loc}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'attendance_' + new Date().toISOString().split('T')[0] + '.csv'; a.click();
    URL.revokeObjectURL(url);
    toast('CSV downloaded', 'success');
}
async function downloadLogs() {
    const logs = await getAttendance();
    if (!logs.length) { toast('No logs to export', 'warning'); return; }
    const sessions = buildSessions(logs);
    const rows = sessions.map((s, i) => `
        <tr>
            <td>${i + 1}</td><td>${s.name}</td><td>ID-${String(s.empId).padStart(4, '0')}</td>
            <td>${s.date}</td>
            <td style="color:#10b981;font-weight:700">${s.punchIn}</td>
            <td style="color:#f59e0b;font-weight:700">${s.punchOut}</td>
            <td>${s.dur}</td>
            <td style="color:${s.late ? '#f43f5e' : '#10b981'};font-weight:600">${s.late ? 'Late' : 'On Time'}</td>
            <td>${s.loc}</td>
        </tr>`).join('');
    const now = new Date();
    const pw = window.open('', '_blank', 'width=1100,height=720');
    if (!pw) { toast('Popup blocked. Allow popups and try again.', 'error'); return; }
    const doc = pw.document;
    doc.title = 'Attendance Report';
    doc.write(`<!DOCTYPE html><html><head><style>body{font-family:Arial,sans-serif;margin:28px;color:#1e293b}h1{color:#4f46e5;margin-bottom:4px}p.m{color:#64748b;font-size:12px;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:12px}th{background:#4f46e5;color:#fff;padding:9px 10px;text-align:left;white-space:nowrap}td{padding:8px 10px;border-bottom:1px solid #e2e8f0}tr:nth-child(even) td{background:#f8fafc}.f{margin-top:20px;font-size:11px;color:#94a3b8;text-align:center}@media print{button{display:none}}</style></head><body>
        <h1>📋 Attendance Report — FaceSync AI Enterprise</h1>
        <p class="m">Generated: ${now.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })} at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} | Sessions: ${sessions.length} | Raw Records: ${logs.length}</p>
        <table><thead><tr><th>#</th><th>Employee</th><th>Emp ID</th><th>Date</th><th>Punch In</th><th>Punch Out</th><th>Duration</th><th>Punctuality</th><th>Location</th></tr></thead><tbody>${rows}</tbody></table>
        <p class="f">FaceSync AI Enterprise — Confidential Attendance Record</p>
        <br><button onclick="window.print()" style="padding:9px 22px;background:#4f46e5;color:white;border:none;border-radius:7px;cursor:pointer;font-size:13px;font-weight:bold">📥 Save as PDF</button>
    </body></html>`);
    doc.close();
    toast('PDF report opened', 'success');
}

// ====== Attendance Correction ======
let correctingLogId = null;
async function openCorrectModal(logId) {
    // Guard: if modal elements missing, page is cached — prompt hard-refresh
    if (!document.getElementById('correct-modal')) {
        toast('Page is outdated \u2014 press Ctrl+Shift+R to reload', 'error', 6000);
        return;
    }
    correctingLogId = Number(logId);
    const all = await getAttendance();
    const log = all.find(l => l.id === correctingLogId);
    if (!log) { toast('Record not found (id=' + correctingLogId + ')', 'error'); return; }
    document.getElementById('correct-name').textContent = log.name || '';
    document.getElementById('correct-status').value = log.status || 'IN';
    const ts = log.timestamp ? new Date(log.timestamp) : null;
    if (ts && !isNaN(ts)) {
        const pad = n => String(n).padStart(2, '0');
        document.getElementById('correct-ts').value =
            ts.getFullYear() + '-' + pad(ts.getMonth() + 1) + '-' + pad(ts.getDate()) +
            'T' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
    }
    document.getElementById('correct-loc').value = log.location || '';
    document.getElementById('correct-modal').classList.add('open');
}
function closeCorrectModal() {
    document.getElementById('correct-modal').classList.remove('open');
    correctingLogId = null;
}
async function saveCorrection() {
    if (!isAdmin()) { toast('Admin access required', 'error'); return; }
    if (!correctingLogId) return;
    const status = document.getElementById('correct-status').value;
    const ts = document.getElementById('correct-ts').value;
    const loc = document.getElementById('correct-loc').value;
    await updateAttendance(correctingLogId, {
        status,
        timestamp: ts ? new Date(ts).toISOString() : undefined,
        location: loc
    });
    closeCorrectModal();
    toast('Record updated successfully', 'success');
    refreshDashboard();
}
async function deleteLog(logId) {
    if (!isAdmin()) { toast('Admin access required', 'error'); return; }
    const id = logId || correctingLogId;
    if (!id) return;
    if (!confirm('Delete this punch record? This cannot be undone.')) return;
    await deleteAttendance(id);
    closeCorrectModal();
    toast('Record deleted', 'info');
    refreshDashboard();
}

// ====== Calendar Heatmap ======
function renderHeatmap(logs) {
    const el = document.getElementById('heatmap-grid');
    if (!el) return;
    const now = new Date();
    const year = now.getFullYear(), month = now.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Count unique attendees per day
    const counts = {};
    logs.forEach(l => {
        const d = new Date(l.timestamp);
        if (d.getFullYear() === year && d.getMonth() === month) {
            const day = d.getDate();
            if (!counts[day]) counts[day] = new Set();
            counts[day].add(l.employee_id);
        }
    });
    const monthName = now.toLocaleDateString('en', { month: 'long', year: 'numeric' });
    document.getElementById('heatmap-month').textContent = monthName;
    const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    let html = days.map(d => `<div style="font-size:10px;font-weight:700;color:#475569;text-align:center">${d}</div>`).join('');
    // Empty cells before first day
    const firstDay = new Date(year, month, 1).getDay();
    for (let i = 0; i < firstDay; i++) html += '<div></div>';
    for (let d = 1; d <= daysInMonth; d++) {
        const cnt = counts[d] ? counts[d].size : 0;
        const isToday = d === now.getDate();
        const color = cnt === 0 ? 'rgba(255,255,255,.04)' : cnt <= 2 ? 'rgba(99,102,241,.3)' : cnt <= 5 ? 'rgba(99,102,241,.65)' : '#6366f1';
        html += `<div title="${cnt} employee${cnt !== 1 ? 's' : ''} present" style="aspect-ratio:1;border-radius:5px;background:${color};border:${isToday ? '2px solid #818cf8' : '1px solid rgba(255,255,255,.05)'};cursor:default;display:flex;align-items:center;justify-content:center;font-size:10px;color:${cnt > 0 ? '#e2e8f0' : '#334155'};font-weight:600">${d}</div>`;
    }
    el.innerHTML = html;
}

// ====== Navigation ======
function showSection(name) {
    const sections = ['dashboard', 'kiosk', 'employees', 'analytics', 'settings'];
    sections.forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.remove('active');
        const nb = document.getElementById('nav-' + s);
        if (nb) nb.classList.remove('active');
    });
    const target = document.getElementById(name);
    if (target) target.classList.add('active');
    const nb = document.getElementById('nav-' + name);
    if (nb) nb.classList.add('active');
    if (name === 'employees') refreshEmployees();
    else if (name === 'dashboard') refreshDashboard();
    else if (name === 'analytics') refreshAnalytics();
    else if (name === 'settings') updateSettingsUI();
}

// ====== Clock ======
function updateClock() {
    const n = new Date();
    const te = document.getElementById('clock-time');
    const de = document.getElementById('clock-date');
    if (te) te.textContent = n.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (de) de.textContent = n.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// ====== Init ======
window.onload = async () => {
    setInterval(updateClock, 1000);
    updateClock();
    await loadSettings();
    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => { });
    }
    // Restore session from localStorage
    const savedRole = localStorage.getItem('fsRole');
    if (savedRole === 'admin') {
        // Re-check Firebase Auth state
        auth.onAuthStateChanged(async user => {
            if (user) {
                currentUser = { uid: user.uid, role: 'admin', empId: null };
                hideLoginScreen();
                applyRoleUI();
                await loadSettings(true); // Re-sync now that we are authenticated
                await refreshDashboard();
                await loadModels();
            } else {
                showLoginScreen();
            }
        });
    } else if (savedRole === 'employee') {
        const empId = localStorage.getItem('fsEmpId');
        if (empId) {
            signInEmployee(empId);
            hideLoginScreen();
            applyRoleUI();
            await refreshDashboard();
            await loadModels();
        } else { showLoginScreen(); }
    } else {
        showLoginScreen();
    }
    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
        const map = { d: 'dashboard', k: 'kiosk', a: 'analytics', e: 'employees', s: 'settings' };
        const key = e.key.toLowerCase();
        if (map[key] && currentUser) {
            const adminOnly = (key === 'e' || key === 's' || key === 'k');
            if (adminOnly && !isAdmin()) { toast('Admin only', 'warning'); return; }
            showSection(map[key]);
            toast('Shortcut: ' + map[key].charAt(0).toUpperCase() + map[key].slice(1), 'info', 1500);
        }
    });

    // Auto-resume sync when returning to app (fixes background sleep on mobile)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && isAdmin()) {
            console.log("📱 App focused — verifying cloud sync...");
            loadSettings(true);
        }
    });
};
