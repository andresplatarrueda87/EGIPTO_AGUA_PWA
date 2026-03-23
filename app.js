// EGIPTO AGUA - Core Logic
const CONFIG = {
    BROKER: 'wss://broker.emqx.io:8084/mqtt',
    ENCRYPTION_KEY: 'TwR4AUlhiTDyFZtaFnZXIoeGQYyvpHAIYxRY3tbg+rE=',
    TOPICS: {
        BASE: 'tapa/gw/#',
        STATUS: 'gateway/status',
        OPCUA: 'gateway/opcua/status',
        HEARTBEAT: 'heartbeat'
    }
};

// --- Security Module ---
const SecurityUtils = {
    decrypt(base64Payload) {
        if (!base64Payload) return { text: '', isEncrypted: false };

        try {
            // 1. Decode to WordArray
            const fullRaw = CryptoJS.enc.Base64.parse(base64Payload);
            // Must have at least IV (16 bytes)
            if (fullRaw.sigBytes < 16) return { text: base64Payload, isEncrypted: false };

            // 2. Extract IV (First 4 words = 16 bytes)
            const iv = CryptoJS.lib.WordArray.create(fullRaw.words.slice(0, 4), 16);

            // 3. Extract Ciphertext (The rest)
            const ciphertext = CryptoJS.lib.WordArray.create(fullRaw.words.slice(4), fullRaw.sigBytes - 16);

            // 4. Prepare Key (32 bytes = 8 words)
            const keyRaw = CryptoJS.enc.Base64.parse(CONFIG.ENCRYPTION_KEY);
            const key = CryptoJS.lib.WordArray.create(keyRaw.words.slice(0, 8), 32);

            // 5. Decrypt AES-256-CBC
            const decrypted = CryptoJS.AES.decrypt(
                { ciphertext: ciphertext },
                key,
                { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
            );

            // 6. Convert to UTF-8
            const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
            if (!decryptedText) {
                // If it looks like base64 but can't be decrypted, it might be raw data that just fits the profile
                return { text: base64Payload, isEncrypted: false };
            }
            
            return { text: decryptedText, isEncrypted: true };
        } catch (e) {
            return { text: base64Payload, isEncrypted: false };
        }
    }
};

// --- State Manager ---
const State = {
    isConnected: false,
    isGatewayOnline: false,
    isOpcUaConnected: false,
    isPlcConnected: false,
    lastHeartbeat: 0,
    tags: {
        pressure: { value: '--', timestamp: '', isRetained: false },
        setpoint: { value: '--', timestamp: '', isRetained: false },
        output: { value: '--', timestamp: '', isRetained: false }
    },
    pumps: Array(5).fill(null).map((_, i) => ({
        id: i + 1,
        status: { value: '--', timestamp: '', isRetained: false },
        frequency: { value: '--', timestamp: '', isRetained: false },
        priority: { value: '--', timestamp: '', isRetained: false }
    })),
    showDiagnostics: false,
    notificationsEnabled: false,
    lastAlarmStates: {}
};

// --- Notification Engine ---
const Notifications = {
    async requestPermission() {
        if (!('Notification' in window)) {
            alert('Este navegador no soporta notificaciones nativas.');
            return false;
        }

        if (!window.isSecureContext) {
            alert('ERROR: Las notificaciones requieren una conexión segura (HTTPS) o localhost para funcionar.');
            return false;
        }

        try {
            const permission = await Notification.requestPermission();
            if (permission === 'denied') {
                alert('Las notificaciones han sido bloqueadas. Debe habilitarlas manualmente en la configuración del navegador (sitio).');
                return false;
            }
            return permission === 'granted';
        } catch (e) {
            console.error('Error solicitando permisos:', e);
            return false;
        }
    },

    show(title, body) {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        
        // Prefer showNotification via Service Worker for PWA compliance
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.ready.then(registration => {
                registration.showNotification(title, {
                    body: body,
                    icon: 'egipto_agua_pwa_icon.png',
                    vibrate: [200, 100, 200],
                    tag: 'tapa-alarm'
                });
            });
        } else {
            // Fallback for direct browser notification
            new Notification(title, {
                body: body,
                icon: 'egipto_agua_pwa_icon.png',
                vibrate: [200, 100, 200]
            });
        }
    }
};

// --- UI Engine ---
const UI = {
    init() {
        this.renderPumps();
        this.updateStatus();
        this.setupEventListeners();
        this.loadSettings();
        this.updateDashboard(); // Initial refresh with stored settings
    },

    loadSettings() {
        const diag = localStorage.getItem('diag') === 'true';
        State.showDiagnostics = diag;
        document.getElementById('chk-diagnostics').checked = diag;

        const notify = localStorage.getItem('notify') === 'true';
        State.notificationsEnabled = notify;
        document.getElementById('chk-notifications').checked = notify;
    },

    renderPumps() {
        const container = document.getElementById('pumps-container');
        container.innerHTML = State.pumps.map(pump => `
            <section class="card pump-card" id="pump-${pump.id}">
                <div class="pump-icon-box">
                    <img src="images/pump_gray.png" class="pump-img" id="img-pump-${pump.id}">
                </div>
                <div class="pump-info">
                    <h4>BOMBA ${pump.id}</h4>
                    <span class="pump-status" id="status-pump-${pump.id}">OFFLINE</span>
                    <span class="pump-freq" id="freq-pump-${pump.id}">-- Hz</span>
                </div>
                <div class="pump-priority">
                    <span class="label">PRIORIDAD</span>
                    <span class="prio-badge" id="prio-pump-${pump.id}">--</span>
                </div>
            </section>
        `).join('');
    },

    updateStatus() {
        const indicator = document.getElementById('status-indicator');
        const mainStatus = document.getElementById('system-status');
        const label = indicator.querySelector('.label');
        const statusBox = mainStatus.querySelector('.status-text');
        const statusIcon = mainStatus.querySelector('.icon');

        indicator.className = 'status-indicator ' + (State.isConnected ? 'online' : 'offline');
        label.innerText = State.isConnected ? 'BROKER CONNECTED' : 'DISCONNECTED';

        if (!State.isConnected) {
            mainStatus.style.borderColor = 'var(--accent-red)';
            mainStatus.style.background = 'rgba(248, 81, 73, 0.1)';
            statusIcon.innerText = '🔴';
            statusBox.innerHTML = '<h3 style="color:var(--accent-red)">SIN CONEXIÓN AL BROKER</h3><p>Verifique su conexión a internet</p>';
        } else if (!State.isGatewayOnline) {
            mainStatus.style.borderColor = 'var(--accent-red)';
            mainStatus.style.background = 'rgba(248, 81, 73, 0.1)';
            statusIcon.innerText = '⚠️';
            statusBox.innerHTML = '<h3 style="color:var(--accent-red)">GATEWAY OFFLINE</h3><p>El servicio principal no responde</p>';
        } else if (!State.isOpcUaConnected) {
            mainStatus.style.borderColor = 'var(--accent-orange)';
            mainStatus.style.background = 'rgba(210, 153, 34, 0.1)';
            statusIcon.innerText = '🔌';
            statusBox.innerHTML = '<h3 style="color:var(--accent-orange)">DRIVER OPC UA OFFLINE</h3><p>Gateway OK, pero sin conexión al servidor OPC UA</p>';
        } else if (!State.isPlcConnected) {
            mainStatus.style.borderColor = 'var(--accent-orange)';
            mainStatus.style.background = 'rgba(210, 153, 34, 0.1)';
            statusIcon.innerText = '❄️';
            statusBox.innerHTML = '<h3 style="color:var(--accent-orange)">PLC DESCONECTADO</h3><p>Conexiones OK, pero sin datos frescos del PLC</p>';
        } else {
            mainStatus.style.borderColor = 'var(--accent-green)';
            mainStatus.style.background = 'rgba(63, 185, 80, 0.1)';
            statusIcon.innerText = '✅';
            statusBox.innerHTML = '<h3 style="color:var(--accent-green)">SISTEMA OPERANDO</h3><p>Conexiones estables y datos vivos</p>';
        }
    },

    formatVal(val, decimals = 2) {
        const n = parseFloat(val);
        return isNaN(n) ? '--' : n.toFixed(decimals);
    },

    updateDashboard() {
        const pTag = State.tags.pressure;
        document.getElementById('txt-pressure').innerText = this.formatVal(pTag.value);
        document.getElementById('txt-setpoint').innerText = this.formatVal(State.tags.setpoint.value);
        
        const outEl = document.getElementById('txt-output');
        if (outEl) outEl.innerText = this.formatVal(State.tags.output.value) + ' %';

        const alarm = document.getElementById('pressure-alarm');
        const pVal = parseFloat(pTag.value);
        if (!isNaN(pVal) && pVal > 80) alarm.classList.remove('hidden');
        else alarm.classList.add('hidden');

        // Handle Pressure Diagnostics
        this.updateDiagnostics('pressure-diag', 'tapa/gw/presion', pTag);

        State.pumps.forEach(pump => {
            const statusEl = document.getElementById('status-pump-' + pump.id);
            const freqEl = document.getElementById('freq-pump-' + pump.id);
            const prioEl = document.getElementById('prio-pump-' + pump.id);
            const imgEl = document.getElementById('img-pump-' + pump.id);

            const sVal = pump.status.value;
            statusEl.innerText = this.getPumpStatusText(sVal);
            statusEl.className = 'pump-status ' + this.getPumpStatusClass(sVal);
            freqEl.innerText = this.formatVal(pump.frequency.value) + ' Hz';
            prioEl.innerText = pump.priority.value;
            imgEl.src = this.getPumpIcon(sVal, pump.id);

            // Handle Pump Diagnostics
            this.updateDiagnostics(`pump-${pump.id}-diag`, `tapa/gw/bomba${pump.id}`, pump.status);
        });
    },

    updateDiagnostics(containerId, topic, dataObj) {
        let container = document.getElementById(containerId);
        if (!State.showDiagnostics) {
            if (container) container.classList.add('hidden');
            return;
        }

        if (!container) {
            // Create container if missing (inject before the card or inside)
            const target = document.getElementById(containerId.replace('-diag', '')) || 
                           document.querySelector(containerId.includes('pressure') ? '.pressure-card' : `#pump-${containerId.match(/\d+/)[0]}`);
            
            container = document.createElement('div');
            container.id = containerId;
            container.className = 'diagnostic-badge-root';
            target.parentNode.insertBefore(container, target);
        }

        container.classList.remove('hidden');
        
        // Logical state: If Gateway is offline, even direct data is effectively "retained" (last known)
        const effectiveRetained = dataObj.isRetained || !State.isGatewayOnline || !State.isPlcConnected;
        
        const badgeClass = effectiveRetained ? 'diag-retained' : 'diag-live';
        const badgeText = effectiveRetained ? '⚠ RETENIDO' : '● LIVE';
        
        // Optional: Localize timestamp
        let timeDisplay = '';
        if (dataObj.timestamp) {
            try {
                const date = new Date(dataObj.timestamp);
                timeDisplay = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            } catch(e) { timeDisplay = dataObj.timestamp; }
        }

        container.innerHTML = `
            <div class="diag-topic">${topic}</div>
            <div class="diag-meta">
                <span class="diag-status ${badgeClass}">${badgeText}</span>
                ${timeDisplay ? `<span class="diag-time">🕒 ${timeDisplay}</span>` : ''}
            </div>
        `;
    },

    getPumpStatusText(val) {
        const s = parseInt(val);
        if (s === 1) return 'RUNNING';
        if (s === 2) return 'FAULTED';
        if (s === -1) return 'STARTING';
        if (s === 0) return 'STOPPED';
        return 'UNKNOWN';
    },

    getPumpStatusClass(val) {
        const s = parseInt(val);
        if (s === 1) return 'status-running';
        if (s === 2) return 'status-faulted';
        if (s === -1) return 'status-starting';
        return 'status-stopped';
    },

    getPumpIcon(val, pumpId) {
        // Special Case: Check if local photo exists (Manual config for now)
        const realPhotos = {
            // '1': 'images/motor_bomba_1.jpg', 
            // '2': 'images/motor_bomba_2.jpg'
        };

        if (realPhotos[pumpId]) return realPhotos[pumpId];

        const s = parseInt(val);
        if (s === 1) return 'images/pump_green.png';
        if (s === 2) return 'images/pump_red.png';
        if (s === -1) return 'images/pump_yellow.png';
        return 'images/pump_gray.png';
    },

    setupEventListeners() {
        document.getElementById('btn-settings').onclick = () => document.getElementById('settings-panel').classList.remove('hidden');
        document.getElementById('close-settings').onclick = () => document.getElementById('settings-panel').classList.add('hidden');
        
        document.getElementById('chk-diagnostics').onchange = (e) => {
            State.showDiagnostics = e.target.checked;
            localStorage.setItem('diag', e.target.checked);
            this.updateDashboard(); // Force UI update immediately
        };

        document.getElementById('chk-notifications').onchange = async (e) => {
            if (e.target.checked) {
                const granted = await Notifications.requestPermission();
                if (!granted) {
                    e.target.checked = false;
                    State.notificationsEnabled = false;
                } else {
                    State.notificationsEnabled = true;
                }
                localStorage.setItem('notify', State.notificationsEnabled);
            } else {
                State.notificationsEnabled = false;
                localStorage.setItem('notify', 'false');
            }
        };
    }
};

// --- MQTT Engine ---
const MQTT = {
    client: null,

    connect() {
        console.log('Connecting to MQTT...');
        const activeTopic = 'tapa/gw/client/android/active';
        
        this.client = mqtt.connect(CONFIG.BROKER, {
            clientId: 'EgyptPWA_' + Math.random().toString(16).substring(2, 8),
            keepalive: 60,
            clean: true,
            will: {
                topic: activeTopic,
                payload: 'false',
                qos: 1,
                retain: true
            }
        });

        this.client.on('connect', () => {
            console.log('Connected to Broker ✓');
            State.isConnected = true;
            UI.updateStatus();
            
            this.publishActive(true);
            
            this.client.subscribe(CONFIG.TOPICS.BASE);
            this.client.subscribe(CONFIG.TOPICS.STATUS);
            this.client.subscribe(CONFIG.TOPICS.OPCUA);
            this.client.subscribe(CONFIG.TOPICS.HEARTBEAT);
        });

        this.client.on('message', (topic, payload, packet) => {
            const topicLower = topic.toLowerCase();
            const message = payload.toString();
            this.handleMessage(topicLower, message, packet);
        });

        this.client.on('close', () => {
            State.isConnected = false;
            UI.updateStatus();
        });

        // Toggle active state based on tab visibility
        document.addEventListener('visibilitychange', () => {
            this.publishActive(document.visibilityState === 'visible');
        });
    },

    publishActive(isActive) {
        if (!this.client || !this.client.connected) return;
        const topic = 'tapa/gw/client/android/active';
        const payload = isActive ? 'true' : 'false';
        this.client.publish(topic, payload, { qos: 1, retain: true });
        console.log(`[MQTT] Client Active State published: ${payload}`);
    },

    handleMessage(topic, rawPayload, packet) {
        const encryptedTopics = ['presion', 'setpoint', 'output', 'bomba'];
        const isProcessData = encryptedTopics.some(t => topic.includes(t));

        let currentPayload = rawPayload;
        let isRetained = packet ? packet.retain : false;
        let msgTimestamp = '';

        // 1. Optional Decryption
        if (isProcessData) {
            const result = SecurityUtils.decrypt(rawPayload);
            currentPayload = result.text;
        }

        // 2. JSON Extraction
        let finalValue = currentPayload;
        try {
            if (currentPayload.trim().startsWith('{')) {
                const json = JSON.parse(currentPayload);
                if (json.value !== undefined) finalValue = String(json.value);
                if (json.timestamp) msgTimestamp = json.timestamp;
            }
        } catch (e) {}

        const dataObj = { value: finalValue, timestamp: msgTimestamp, isRetained: isRetained };
        this.processData(topic.toLowerCase(), dataObj);
        this.handleAlarms(topic.toLowerCase(), finalValue, isRetained);
        UI.updateDashboard();
    },

    handleAlarms(topic, payload, isRetained) {
        if (!State.notificationsEnabled) return;
        if (isRetained) return; // No notificar por datos antiguos (históricos)

        const valueStr = String(payload);
        
        // Alertas de Presión
        if (topic.includes('presion')) {
            const pressurePart = valueStr.includes('|') ? valueStr.split('|')[0] : valueStr;
            const val = parseFloat(pressurePart);
            if (!isNaN(val)) {
                const isHigh = val > 80;
                const wasHigh = State.lastAlarmStates['pressure_high'];
                if (isHigh && !wasHigh) {
                    Notifications.show('¡Alerta de Presión!', `La presión ha subido a ${val.toFixed(1)} PSI`);
                }
                State.lastAlarmStates['pressure_high'] = isHigh;
            }
        }

        // Alertas de Bombas
        if (topic.includes('bomba')) {
            const match = topic.match(/bomba.*?(\d+)/);
            if (match) {
                const id = match[1];
                const statusPart = valueStr.includes('|') ? valueStr.split('|')[0] : valueStr;
                const status = parseInt(statusPart);
                const lastStatus = State.lastAlarmStates['pump_' + id];

                if (status !== lastStatus) {
                    if (status === 0) Notifications.show('Aviso de Planta', `BOMBA ${id} se ha DETENIDO`);
                    if (status === 2) Notifications.show('¡FALLA CRÍTICA!', `BOMBA ${id} está en ESTADO DE FALLA`);
                    State.lastAlarmStates['pump_' + id] = status;
                }
            }
        }
    },

    processData(topic, dataObj) {
        const now = Date.now();
        const payload = dataObj.value;

        // Status topics
        if (topic.endsWith('gateway/status')) {
            try {
                const data = JSON.parse(payload);
                State.isGatewayOnline = data.status === 'online' || data.status === 'connected';
            } catch (e) {
                State.isGatewayOnline = payload.includes('online') || payload === '1' || payload === 'true';
            }
            UI.updateStatus();
        } else if (topic.endsWith('gateway/opcua/status')) {
            try {
                const data = JSON.parse(payload);
                State.isOpcUaConnected = data.status === 'online' || data.status === 'connected';
            } catch (e) {
                State.isOpcUaConnected = payload.includes('online') || payload === 'true';
            }
            UI.updateStatus();
        } else if (topic.endsWith('heartbeat')) {
            State.isPlcConnected = true;
            State.lastHeartbeat = now;
            UI.updateStatus();
        }

        // Process data
        if (topic.includes('presion')) {
            if (payload.includes('|')) {
                const parts = payload.split('|');
                State.tags.pressure = { ...dataObj, value: parts[0] };
                State.tags.setpoint = { ...dataObj, value: parts[1] || '--' };
                State.tags.output = { ...dataObj, value: parts[2] || '--' };
            } else {
                State.tags.pressure = dataObj;
            }
        } else if (topic.includes('bomba')) {
            const match = topic.match(/bomba.*?(\d+)/);
            if (match) {
                const idx = parseInt(match[1]) - 1;
                if (idx >= 0 && idx < 5) {
                    if (payload.includes('|')) {
                        const parts = payload.split('|');
                        State.pumps[idx].status = { ...dataObj, value: parts[0] };
                        State.pumps[idx].frequency = { ...dataObj, value: parts[1] };
                        State.pumps[idx].priority = { ...dataObj, value: parts[2] || '--' };
                    }
                }
            }
        }
    }
};

// --- Watchdog ---
setInterval(() => {
    const now = Date.now();
    if (State.isPlcConnected && (now - State.lastHeartbeat > 25000)) {
        State.isPlcConnected = false;
        UI.updateStatus();
    }
}, 5000);

// Init
UI.init();
MQTT.connect();
