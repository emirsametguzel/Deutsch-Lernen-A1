        const unitsData = window.unitsData;

        // Current state
        let currentView = 'home';
        let currentUnit = null;
        let currentSection = null;
        let exerciseScores = {};
        let testScores = {};
        let darkMode = false;
        let studentInfo = null;
        let studentDocId = null;
        let currentAuthUser = null;
        let appInitialized = false;
        let isTeacher = false;
        let adminEmails = [];
        let contentListener = null; // For real-time content updates

        const ADMIN_CONFIG_PATH = { collection: 'config', doc: 'admins' };
        const FALLBACK_ADMIN_EMAILS = ['emirsametguzel@gmail.com'];
        const ALLOWED_CLASSES = ['hazirlik_a', 'hazirlik_b', 'hazirlik_c'];
        const HOMEWORK_COLLECTION = 'homeworks';
        const PROGRESS_COLLECTION = 'progress';
        const UNITS_COLLECTION = 'units';

        function normalizeEmail(email) {
            return String(email || '').trim().toLowerCase();
        }

        function isAllowedClassName(className) {
            return ALLOWED_CLASSES.includes(String(className || '').trim().toLowerCase());
        }

        function normalizeClassName(className) {
            const normalized = String(className || '').trim().toLowerCase();
            return isAllowedClassName(normalized) ? normalized : '';
        }

        function getUnitIdValue(unitId) {
            const n = Number(unitId);
            return Number.isFinite(n) ? String(n) : '';
        }

        function buildUnitContentsFromLocalData(unitId) {
            const u = getUnitIdValue(unitId);
            if (!u || !unitsData[u]) return [];
            const unit = unitsData[u];
            const items = [
                `u${u}:section:kommunikation`,
                `u${u}:section:wortschatz`,
                `u${u}:section:grammatik`,
                `u${u}:section:ubungen`,
                `u${u}:section:test`,
                `u${u}:test:final`
            ];
            (unit.kommunikation?.examples || []).forEach((_, idx) => items.push(`u${u}:kommunikation:example:${idx}`));
            (unit.kommunikation?.dialogues || []).forEach((_, idx) => items.push(`u${u}:kommunikation:dialogue:${idx}`));
            (unit.wortschatz || []).forEach((_, idx) => items.push(`u${u}:wortschatz:${idx}`));
            (unit.grammatik || []).forEach((_, idx) => items.push(`u${u}:grammatik:${idx}`));
            for (let i = 0; i < 10; i += 1) items.push(`u${u}:exercise:${i}`);
            return Array.from(new Set(items));
        }

        async function getUnitContents(unitId) {
            const unitIdValue = getUnitIdValue(unitId);
            if (!unitIdValue) return [];
            if (!db) return buildUnitContentsFromLocalData(unitIdValue);
            try {
                const snap = await db.collection(UNITS_COLLECTION).doc(unitIdValue).get();
                const data = snap.exists ? (snap.data() || {}) : {};
                const fsContents = Array.isArray(data.contents) ? data.contents.map(String) : [];
                if (fsContents.length > 0) return Array.from(new Set(fsContents));
            } catch (err) {
                console.warn('Unit contents read fallback:', err);
            }
            return buildUnitContentsFromLocalData(unitIdValue);
        }

        async function ensureUnitDocument(unitId) {
            const unitIdValue = getUnitIdValue(unitId);
            if (!unitIdValue || !db || !isTeacher) return;
            const contents = buildUnitContentsFromLocalData(unitIdValue);
            if (contents.length === 0) return;
            try {
                await db.collection(UNITS_COLLECTION).doc(unitIdValue).set({
                    id: unitIdValue,
                    contents,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    updatedBy: currentAuthUser?.uid || ''
                }, { merge: true });
            } catch (err) {
                console.warn('Unit document sync skipped:', err);
            }
        }

        async function markContentCompleted(contentId, unitId) {
            if (!db || !currentAuthUser?.uid || !contentId) return;
            const uid = currentAuthUser.uid;
            const key = `${uid}__${contentId}`;
            try {
                await db.collection(PROGRESS_COLLECTION).doc(key).set({
                    userId: uid,
                    contentId: String(contentId),
                    unitId: getUnitIdValue(unitId || currentUnit),
                    completedAt: firebase.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            } catch (error) {
                console.warn('Progress write skipped:', error);
            }
        }

        function progressPercent(completed, total) {
            if (!total || total <= 0) return 0;
            return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
        }

        function parseDeadlineDate(deadlineAt) {
            if (!deadlineAt) return null;
            if (deadlineAt?.toDate) return deadlineAt.toDate();
            const d = new Date(deadlineAt);
            return Number.isNaN(d.getTime()) ? null : d;
        }

        async function getUserProgressByUnit(userId, unitId) {
            if (!db || !userId || !unitId) return [];
            try {
                const snap = await db.collection(PROGRESS_COLLECTION)
                    .where('userId', '==', userId)
                    .where('unitId', '==', getUnitIdValue(unitId))
                    .get();
                return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            } catch (error) {
                console.warn('Progress query failed:', error);
                return [];
            }
        }

        async function calculateHomeworkProgressForUser(homework, userId) {
            const unitId = getUnitIdValue(homework?.unitId);
            if (!unitId || !userId) {
                return { totalContents: 0, completedNow: 0, progressNow: 0, completedBeforeDeadline: 0, progressBeforeDeadline: 0, isLate: false };
            }
            const [contents, rows] = await Promise.all([
                getUnitContents(unitId),
                getUserProgressByUnit(userId, unitId)
            ]);
            const contentSet = new Set(contents.map(String));
            const deadlineDate = parseDeadlineDate(homework?.deadlineAt);
            const doneNow = new Set();
            const doneBeforeDeadline = new Set();

            rows.forEach((row) => {
                const cid = String(row.contentId || '');
                if (!cid || !contentSet.has(cid)) return;
                doneNow.add(cid);
                const completedAtDate = row.completedAt?.toDate ? row.completedAt.toDate() : null;
                if (!deadlineDate || (completedAtDate && completedAtDate <= deadlineDate)) {
                    doneBeforeDeadline.add(cid);
                }
            });

            const total = contentSet.size;
            const completedNow = doneNow.size;
            const completedBeforeDeadline = doneBeforeDeadline.size;
            const nowDate = new Date();
            return {
                totalContents: total,
                completedNow,
                progressNow: progressPercent(completedNow, total),
                completedBeforeDeadline,
                progressBeforeDeadline: progressPercent(completedBeforeDeadline, total),
                isLate: !!deadlineDate && nowDate > deadlineDate
            };
        }

        async function ensureFirestoreAuthReady(forceRefresh = false) {
            const user = auth?.currentUser || currentAuthUser;
            if (!user) return false;
            try {
                await user.getIdToken(forceRefresh);
                currentAuthUser = user;
                return true;
            } catch (error) {
                console.warn('Auth-Token konnte nicht geholt werden:', error);
                return false;
            }
        }

        async function getQuerySnapshotWithAuthRetry(queryFactory) {
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    const ready = await ensureFirestoreAuthReady(attempt === 1);
                    if (!ready) throw new Error('Die Anmeldung ist nicht gültig. Bitte melden Sie sich erneut an.');
                    return await queryFactory().get();
                } catch (error) {
                    lastError = error;
                    const code = String(error?.code || '');
                    const retryable = code.includes('permission-denied') || code.includes('unauthenticated');
                    if (attempt === 0 && retryable) {
                        await new Promise((resolve) => setTimeout(resolve, 300));
                        continue;
                    }
                    throw error;
                }
            }
            throw lastError || new Error('Abfrage fehlgeschlagen.');
        }

        function computeIsTeacher() {
            const email = normalizeEmail(currentAuthUser?.email || studentInfo?.email || '');
            if (!email) return false;
            return (adminEmails || []).map(normalizeEmail).includes(email);
        }

        function applyTeacherUiState() {
            isTeacher = computeIsTeacher();
            const btn = document.getElementById('teacherBtn');
            if (btn) btn.classList.toggle('hidden', !isTeacher);
            updateStudentDisplay();
        }

        async function loadAdminEmailsFromFirestore() {
            if (!db) {
                adminEmails = [...FALLBACK_ADMIN_EMAILS];
                return adminEmails;
            }
            try {
                const snap = await db.collection(ADMIN_CONFIG_PATH.collection).doc(ADMIN_CONFIG_PATH.doc).get();
                const data = snap.exists ? (snap.data() || {}) : {};
                const emails = Array.isArray(data.emails) ? data.emails : [];
                adminEmails = emails.length ? emails : [...FALLBACK_ADMIN_EMAILS];
                return adminEmails;
            } catch (e) {
                    console.warn('Admin-E-Mails konnten nicht geladen werden, Fallback wird genutzt:', e);
                adminEmails = [...FALLBACK_ADMIN_EMAILS];
                return adminEmails;
            }
        }

        async function refreshAdminState() {
            await loadAdminEmailsFromFirestore();
            applyTeacherUiState();
        }

        // Initialize app after authentication
        async function init() {
            if (appInitialized) return;
            appInitialized = true;
            loadProgress();
            loadContentFromFirestore(); // Load dynamic content
            updateStudentDisplay();
            showHome();
            updateGlobalProgress();
            checkCertificateEligibility();
        }

        function setAppLocked(locked) {
            const gate = document.getElementById('authGate');
            const shell = document.getElementById('appShell');
            if (gate) gate.classList.toggle('hidden', !locked);
            if (shell) shell.classList.toggle('hidden', locked);
        }

        function setAuthMessage(message, type = 'error') {
            const el = document.getElementById('authMessage');
            if (!el) return;
            if (!message) {
                el.className = 'auth-message hidden';
                el.textContent = '';
                return;
            }
            el.className = `auth-message ${type}`;
            el.textContent = message;
        }

        function showLoginForm() {
            document.getElementById('loginForm')?.classList.remove('hidden');
            document.getElementById('registerForm')?.classList.add('hidden');
            document.getElementById('resetForm')?.classList.add('hidden');
            setAuthMessage('');
        }

        function showRegisterForm() {
            document.getElementById('loginForm')?.classList.add('hidden');
            document.getElementById('registerForm')?.classList.remove('hidden');
            document.getElementById('resetForm')?.classList.add('hidden');
            setAuthMessage('');
        }

        function showResetForm() {
            document.getElementById('loginForm')?.classList.add('hidden');
            document.getElementById('registerForm')?.classList.add('hidden');
            document.getElementById('resetForm')?.classList.remove('hidden');
            setAuthMessage('');
        }

        async function loginWithEmailPassword() {
            if (!auth) return setAuthMessage('Der Anmeldedienst ist nicht bereit.');
            const email = (document.getElementById('loginEmail')?.value || '').trim();
            const password = document.getElementById('loginPassword')?.value || '';
            if (!email || !password) return setAuthMessage('E-Mail und Passwort sind nötig.');
            try {
                await auth.signInWithEmailAndPassword(email, password);
                setAuthMessage('');
            } catch (e) {
                setAuthMessage(`Anmeldung fehlgeschlagen: ${e.message}`);
            }
        }

        async function loginWithGoogle() {
            if (!auth || !googleProvider) return setAuthMessage('Google-Anmeldung ist nicht bereit.');
            try {
                const result = await auth.signInWithPopup(googleProvider);
                const user = result.user;
                if (user) {
                    await ensureStudentRecordLinked(user, null);
                }
                setAuthMessage('');
            } catch (e) {
                setAuthMessage(`Google-Anmeldung fehlgeschlagen: ${e.message}`);
            }
        }

        async function sendPasswordReset() {
            if (!auth) return setAuthMessage('Der Anmeldedienst ist nicht bereit.');
            const email = (document.getElementById('resetEmail')?.value || '').trim();
            if (!email) return setAuthMessage('Bitte E-Mail eingeben.');
            try {
                await auth.sendPasswordResetEmail(email);
                setAuthMessage('Der Link zum Zurücksetzen wurde an Ihre E-Mail gesendet.', 'success');
            } catch (e) {
                setAuthMessage(`Zurücksetzen fehlgeschlagen: ${e.message}`);
            }
        }

        async function registerWithEmailPassword() {
            if (!auth) return setAuthMessage('Der Anmeldedienst ist nicht bereit.');

            const firstName = (document.getElementById('regFirstName')?.value || '').trim();
            const lastName = (document.getElementById('regLastName')?.value || '').trim();
            const email = (document.getElementById('regEmail')?.value || '').trim();
            const className = (document.getElementById('regClass')?.value || '').trim();
            const number = (document.getElementById('regNumber')?.value || '').trim();
            const password = document.getElementById('regPassword')?.value || '';
            const password2 = document.getElementById('regPassword2')?.value || '';

            if (!firstName || !lastName || !email || !className || !number || !password || !password2) {
                return setAuthMessage('Bitte alle Felder ausfüllen.');
            }
            if (!isAllowedClassName(className)) {
                return setAuthMessage('Ungültige Klasse. Bitte aus der Liste wählen.');
            }
            if (password.length < 6) return setAuthMessage('Das Passwort braucht mindestens 6 Zeichen.');
            if (password !== password2) return setAuthMessage('Die Passwörter sind nicht gleich.');

            try {
                const cred = await auth.createUserWithEmailAndPassword(email, password);
                if (cred.user) {
                    await ensureStudentRecordLinked(cred.user, { firstName, lastName, className, number });
                }
                setAuthMessage('');
            } catch (e) {
                setAuthMessage(`Registrierung fehlgeschlagen: ${e.message}`);
            }
        }

        async function logout() {
            if (!auth) return;
            try {
                await auth.signOut();
            } catch (e) {
                console.warn('Logout error:', e);
            }
        }

        async function initAuthGate() {
            if (!auth) {
                setAuthMessage('Firebase Auth konnte nicht starten.');
                setAppLocked(true);
                return;
            }

            showLoginForm();
            setAppLocked(true);

            auth.onAuthStateChanged(async (user) => {
                currentAuthUser = user || null;

                if (!user) {
                    setAppLocked(true);
                    studentInfo = null;
                    studentDocId = null;
                    isTeacher = false;
                    adminEmails = [];
                    localStorage.removeItem('studentInfo');
                    localStorage.removeItem('studentDocId');
                    return;
                }

                try {
                    await ensureStudentRecordLinked(user, null);
                    await refreshAdminState();
                    setAppLocked(false);
                    updateStudentDisplay();
                    if (!appInitialized) {
                        await init();
                    } else {
                        updateGlobalProgress();
                        checkCertificateEligibility();
                        showHome();
                    }
                } catch (e) {
                    console.error('Auth setup error:', e);
                    setAuthMessage(`Konto konnte nicht vorbereitet werden: ${e.message}`);
                    setAppLocked(true);
                }
            });
        }

        // Load content from Firestore (real-time listener)
        // Load content from Firestore and convert back from safe format
        function loadContentFromFirestore() {
            if (!db) {
                console.log('ℹ️ Kein Firebase, lokale Daten werden genutzt');
                return;
            }
            
            try {
                // Listen for content changes in real-time
                contentListener = db.collection('content').doc('units')
                    .onSnapshot((doc) => {
                        if (doc.exists) {
                            const firestoreData = doc.data();
                            console.log('📥 Daten von Firestore geladen');
                            
                            // Merge Firestore content with local data
                            Object.keys(firestoreData).forEach(unitNum => {
                                if (unitsData[unitNum]) {
                                    const fsUnit = firestoreData[unitNum];
                                    
                                    // Merge basic fields
                                    unitsData[unitNum].title = fsUnit.title || unitsData[unitNum].title;
                                    unitsData[unitNum].subtitle = fsUnit.subtitle || unitsData[unitNum].subtitle;
                                    unitsData[unitNum].color = fsUnit.color || unitsData[unitNum].color;
                                    
                                    // Merge kommunikation
                                    if (fsUnit.kommunikation) {
                                        unitsData[unitNum].kommunikation.skills = fsUnit.kommunikation.skills || unitsData[unitNum].kommunikation.skills;
                                        unitsData[unitNum].kommunikation.examples = fsUnit.kommunikation.examples || unitsData[unitNum].kommunikation.examples;
                                        
                                        // Convert dialogues back if needed
                                        if (fsUnit.kommunikation.dialogues && Array.isArray(fsUnit.kommunikation.dialogues)) {
                                            unitsData[unitNum].kommunikation.dialogues = fsUnit.kommunikation.dialogues.map(d => ({
                                                speaker: d.speaker || '',
                                                text: d.text || ''
                                            }));
                                        }
                                    }
                                    
                                    // Merge wortschatz
                                    if (fsUnit.wortschatz && Array.isArray(fsUnit.wortschatz)) {
                                        unitsData[unitNum].wortschatz = fsUnit.wortschatz;
                                    }
                                    
                                    // Convert grammatik back from Firestore format
                                    if (fsUnit.grammatik && Array.isArray(fsUnit.grammatik)) {
                                        unitsData[unitNum].grammatik = convertGrammatikFromFirestore(fsUnit.grammatik);
                                    }
                                    
                                    console.log(`   ✅ Themenkreis ${unitNum} aktualisiert`);
                                }
                            });
                            
                            console.log('✅ Inhalte von Firestore aktualisiert');
                            
                            // Refresh current view if needed
                            if (currentView === 'unit' && currentUnit) {
                                showUnit(currentUnit);
                            }
                        } else {
                            console.log('ℹ️ Keine Inhalte in Firestore, Standarddaten werden genutzt');
                        }
                    }, (error) => {
                        console.error('❌ Fehler beim Laden der Inhalte:', error);
                    });
            } catch (error) {
                console.error('❌ Firestore-Listener-Fehler:', error);
            }
        }

        async function ensureStudentRecordLinked(user, registrationPayload) {
            if (!user || !db) {
                throw new Error('Kein Nutzer oder keine Datenbankverbindung.');
            }

            const firstName = (registrationPayload?.firstName || '').trim();
            const lastName = (registrationPayload?.lastName || '').trim();
            const regClass = normalizeClassName(registrationPayload?.className || '');
            const regNumber = (registrationPayload?.number || '').trim();
            const regFullName = `${firstName} ${lastName}`.trim();

            let docRef = null;
            const byUid = await db.collection('students').where('uid', '==', user.uid).limit(1).get();
            if (!byUid.empty) {
                docRef = byUid.docs[0].ref;
            } else if (regFullName) {
                // Migration-friendly fallback: first registration with this app can bind by full name
                const byName = await db.collection('students').where('fullName', '==', regFullName).limit(1).get();
                if (!byName.empty) {
                    docRef = byName.docs[0].ref;
                }
            }

            if (!docRef) {
                // For returning users without payload, create lightweight record from auth email prefix
                const fallbackName = regFullName || (user.displayName ? user.displayName.trim() : user.email?.split('@')[0] || 'Schüler/in');
                const fallbackParts = fallbackName.split(' ');
                const fallbackFirst = firstName || fallbackParts[0] || 'Schüler/in';
                const fallbackLast = lastName || fallbackParts.slice(1).join(' ') || '-';

                docRef = await db.collection('students').add({
                    firstName: fallbackFirst,
                    lastName: fallbackLast,
                    fullName: `${fallbackFirst} ${fallbackLast}`.trim(),
                    class: regClass || ALLOWED_CLASSES[0],
                    number: regNumber || '-',
                    email: user.email || '',
                    uid: user.uid,
                    authProvider: user.providerData?.[0]?.providerId || 'password',
                    completedUnits: [],
                    totalPoints: 0,
                    averageScore: 0,
                    testScores: {},
                    exerciseScores: {},
                    favoriteVocabIds: [],
                    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                });
            } else {
                await docRef.update({
                    uid: user.uid,
                    email: user.email || '',
                    authProvider: user.providerData?.[0]?.providerId || 'password',
                    ...(regClass ? { class: regClass } : {}),
                    ...(regNumber ? { number: regNumber } : {}),
                    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                });
            }

            const snap = await docRef.get();
            const data = snap.data() || {};
            studentDocId = snap.id;
            studentInfo = {
                firstName: data.firstName || firstName || '',
                lastName: data.lastName || lastName || '',
                fullName: data.fullName || regFullName || `${firstName} ${lastName}`.trim(),
                class: normalizeClassName(data.class || '') || regClass || ALLOWED_CLASSES[0],
                number: data.number || regNumber || '-',
                email: data.email || user.email || ''
            };
            localStorage.setItem('studentInfo', JSON.stringify(studentInfo));
            localStorage.setItem('studentDocId', studentDocId);
            applyTeacherUiState();

            testScores = data.testScores || {};
            exerciseScores = data.exerciseScores || {};
            saveProgress();
            if (Array.isArray(data.favoriteVocabIds)) {
                window.favoriteVocabIds = new Set(data.favoriteVocabIds.map(String));
                localStorage.setItem('favoriteVocabIds', JSON.stringify(Array.from(window.favoriteVocabIds)));
            }
        }

        // Show student info modal (profile edit)
        function showStudentModal() {
            const modal = document.createElement('div');
            modal.className = 'modal-overlay';
            modal.innerHTML = `
                <div class="modal">
                    <h2>👨‍🎓 Profil</h2>
                    <form id="studentForm" onsubmit="saveStudentInfo(event)">
                        <div class="form-group">
                            <label>Vorname:</label>
                            <input type="text" id="studentFirstName" required>
                        </div>
                        <div class="form-group">
                            <label>Nachname:</label>
                            <input type="text" id="studentLastName" required>
                        </div>
                        <div class="form-group">
                            <label>Klasse:</label>
                            <select id="studentClass" required>
                                ${ALLOWED_CLASSES.map((className) => `<option value="${className}">${className}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Schulnummer:</label>
                            <input type="text" id="studentNumber" required>
                        </div>
                        <button type="submit" class="btn btn-primary" style="width: 100%;">
                            Speichern
                        </button>
                    </form>
                </div>
            `;
            document.body.appendChild(modal);
        }

        // Save student info (profile update for authenticated user)
        async function saveStudentInfo(event) {
            event.preventDefault();
            const firstName = document.getElementById('studentFirstName').value.trim();
            const lastName = document.getElementById('studentLastName').value.trim();
            const className = normalizeClassName(document.getElementById('studentClass').value);
            const number = document.getElementById('studentNumber').value.trim();
            const fullName = `${firstName} ${lastName}`;
            if (!className) {
                alert('Bitte eine gültige Klasse wählen.');
                return;
            }
            
            studentInfo = {
                firstName: firstName,
                lastName: lastName,
                fullName: fullName,
                class: className,
                number: number,
                createdAt: new Date().toISOString()
            };
            
            localStorage.setItem('studentInfo', JSON.stringify(studentInfo));
            applyTeacherUiState();
            
            if (db && studentDocId) {
                try {
                    await db.collection('students').doc(studentDocId).update({
                        firstName: firstName,
                        lastName: lastName,
                        fullName: fullName,
                        class: className,
                        number: number,
                        email: currentAuthUser?.email || studentInfo.email || '',
                        uid: currentAuthUser?.uid || null,
                        authProvider: currentAuthUser?.providerData?.[0]?.providerId || 'password',
                        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                    });
                } catch (error) {
                    console.error('❌ Firestore-Speichern fehlgeschlagen:', error);
                }
            }
            
            document.querySelector('.modal-overlay').remove();
            updateStudentDisplay();
            updateGlobalProgress();
            checkCertificateEligibility();
        }

        // Update student display in header
        function updateStudentDisplay() {
            const display = document.getElementById('studentInfoDisplay');
            if (studentInfo) {
                const email = normalizeEmail(currentAuthUser?.email || studentInfo?.email || '');
                display.innerHTML = `
                    <div class="student-info" onclick="editStudentInfo()">
                        👤 ${studentInfo.fullName} | Klasse: ${studentInfo.class} | Nr.: ${studentInfo.number}
                        ${email ? `<span style="opacity:.9; margin-left:.5rem;">(${email})</span>` : ''}
                        ${isTeacher ? '<span class="teacher-badge">LEHRER/IN</span>' : ''} ✏️
                    </div>
                `;
            }
        }

        // Edit student info
        function editStudentInfo() {
            showStudentModal();
            if (studentInfo) {
                setTimeout(() => {
                    document.getElementById('studentFirstName').value = studentInfo.firstName || '';
                    document.getElementById('studentLastName').value = studentInfo.lastName || '';
                    document.getElementById('studentClass').value = normalizeClassName(studentInfo.class) || ALLOWED_CLASSES[0];
                    document.getElementById('studentNumber').value = studentInfo.number;
                }, 100);
            }
        }

        // Update student data in Firestore after test completion
        async function updateStudentInFirestore() {
            if (!studentDocId || !db) return;
            
            try {
                const completedUnits = Object.keys(testScores).filter(key => testScores[key] > 0).map(Number);
                const totalPoints = Object.values(exerciseScores).reduce((a, b) => a + b, 0);
                const avgScore = completedUnits.length > 0 
                    ? Math.round(Object.values(testScores).reduce((a, b) => a + b, 0) / completedUnits.length)
                    : 0;
                
                await db.collection('students').doc(studentDocId).update({
                    completedUnits: completedUnits,
                    totalPoints: totalPoints,
                    averageScore: avgScore,
                    testScores: testScores,
                    exerciseScores: exerciseScores,
                    favoriteVocabIds: window.favoriteVocabIds ? Array.from(window.favoriteVocabIds) : [],
                    uid: currentAuthUser?.uid || null,
                    email: currentAuthUser?.email || studentInfo?.email || '',
                    authProvider: currentAuthUser?.providerData?.[0]?.providerId || 'password',
                    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                });
                
                console.log('✅ Schülerdaten aktualisiert');
            } catch (error) {
                console.error('❌ Firestore-Update fehlgeschlagen:', error);
            }
        }

        // ============================================
        // GERMAN TEXT-TO-SPEECH SYSTEM (de-DE ONLY)
        // Rebuilt from scratch for reliable German pronunciation
        // ============================================
        
        let germanVoice = null;
        let voicesReady = false;
        
        // Initialize German TTS system
        function initGermanTTS() {
            if (!('speechSynthesis' in window)) {
                console.error('❌ Dieser Browser unterstützt keine SpeechSynthesis');
                return;
            }
            
            const loadVoices = () => {
                const allVoices = window.speechSynthesis.getVoices();
                if (allVoices.length === 0) return;
                
                console.log('🔍 Mevcut sesler:', allVoices.length);
                
                // STRICT German voice selection - ONLY de-DE or de-* voices
                const germanVoices = allVoices.filter(v => {
                    const lang = v.lang.toLowerCase();
                    // MUST start with 'de' - German language code
                    return lang === 'de-de' || lang === 'de-at' || lang === 'de-ch' || lang.startsWith('de-');
                });
                
                console.log('🇩🇪 Deutsche Stimmen:', germanVoices.length);
                germanVoices.forEach(v => console.log('   -', v.name, '|', v.lang));
                
                if (germanVoices.length > 0) {
                    // Sort by preference: de-DE first, then quality indicators
                    germanVoices.sort((a, b) => {
                        let scoreA = 0, scoreB = 0;
                        const nameA = a.name.toLowerCase();
                        const nameB = b.name.toLowerCase();
                        
                        // Prefer de-DE
                        if (a.lang.toLowerCase() === 'de-de') scoreA += 100;
                        if (b.lang.toLowerCase() === 'de-de') scoreB += 100;
                        
                        // Prefer quality voices
                        const qualityNames = ['anna', 'hedda', 'katja', 'helena', 'stefan', 'google', 'microsoft'];
                        qualityNames.forEach(name => {
                            if (nameA.includes(name)) scoreA += 20;
                            if (nameB.includes(name)) scoreB += 20;
                        });
                        
                        // Prefer local voices
                        if (a.localService) scoreA += 10;
                        if (b.localService) scoreB += 10;
                        
                        return scoreB - scoreA;
                    });
                    
                    germanVoice = germanVoices[0];
                    voicesReady = true;
                    console.log('✅ Gewählte deutsche Stimme:', germanVoice.name, '|', germanVoice.lang);
                } else {
                    console.warn('⚠️ Keine deutsche Stimme gefunden, Browser-Standard wird genutzt.');
                    voicesReady = true; // Still ready, will use lang attribute fallback
                }
            };
            
            // Load voices immediately if available
            if (window.speechSynthesis.getVoices().length > 0) {
                loadVoices();
            }
            
            // Also listen for voiceschanged event (Chrome needs this)
            window.speechSynthesis.onvoiceschanged = loadVoices;
        }
        
        // Main German speech function
        // Online TTS fallback (free, no key) - best effort
        // Note: This uses an external endpoint; availability can vary by network/browser.
        let _ttsAudioEl = null;
        let _lastTtsUrl = null;
        function playOnlineGermanTTS(text) {
            if (!text || text.trim() === '') return false;
            const q = encodeURIComponent(text.trim());

            // Prefer local PHP proxy (avoids CORS; works on InfinityFree)
            const urlLocal = `tts.php?tl=de-DE&q=${q}`;

            // Try a commonly working endpoint first.
            // If it fails (network/CORS), user will still have local speech if available.
            const urlPrimary = `https://translate.googleapis.com/translate_tts?client=gtx&tl=de&ie=UTF-8&q=${q}`;
            const urlSecondary = `https://translate.google.com/translate_tts?ie=UTF-8&tl=de&client=tw-ob&q=${q}`;

            try {
                if (!_ttsAudioEl) {
                    _ttsAudioEl = new Audio();
                    _ttsAudioEl.preload = 'none';
                }
                // stop any current audio
                _ttsAudioEl.pause();
                _ttsAudioEl.currentTime = 0;

                const tryUrl = (url) => new Promise((resolve, reject) => {
                    _ttsAudioEl.onended = () => resolve(true);
                    _ttsAudioEl.onplay = () => resolve(true);
                    _ttsAudioEl.onerror = () => reject(new Error('audio error'));
                    _ttsAudioEl.src = url;
                    _lastTtsUrl = url;
                    const p = _ttsAudioEl.play();
                    if (p && typeof p.catch === 'function') p.catch(reject);
                });

                return tryUrl(urlLocal)
                    .catch(() => tryUrl(urlPrimary))
                    .catch(() => tryUrl(urlSecondary))
                    .then(() => true)
                    .catch((e) => {
                    console.warn('⚠️ Online-TTS fehlgeschlagen:', e);
                    return false;
                });
            } catch (e) {
                console.warn('⚠️ Online TTS hata:', e);
                return false;
            }
        }

        function speakGerman(text) {
            if (!text || text.trim() === '') return;

            // A/B: Try browser SpeechSynthesis first (best offline)
            if ('speechSynthesis' in window) {
                try {
                    // Cancel any ongoing speech first
                    window.speechSynthesis.cancel();

                    // Create new utterance
                    const utterance = new SpeechSynthesisUtterance(text);

                    // FORCE German language
                    utterance.lang = 'de-DE';

                    // A: Use cached German voice if available
                    if (germanVoice) {
                        utterance.voice = germanVoice;
                    }

                    // Speech parameters
                    utterance.rate = 0.9;
                    utterance.pitch = 1.0;
                    utterance.volume = 1.0;

                    let spoke = false;
                    utterance.onstart = () => { spoke = true; };
                    utterance.onerror = async (event) => {
                        console.warn('⚠️ SpeechSynthesis hata, online TTS deneniyor:', event.error);
                        await playOnlineGermanTTS(text);
                    };

                    window.speechSynthesis.speak(utterance);

                    // If voices are missing, some browsers fail silently; fallback after a short delay.
                    setTimeout(async () => {
                        if (!spoke && !germanVoice) {
                            await playOnlineGermanTTS(text);
                        }
                    }, 500);

                    return;
                } catch (e) {
                    console.warn('⚠️ SpeechSynthesis nicht nutzbar, Online-TTS wird versucht:', e);
                    // fall through to online
                }
            }

            // C: Online fallback (works even without German voices)
            playOnlineGermanTTS(text);
        }
        
        // Initialize TTS on page load
        if (typeof window !== 'undefined') {
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', initGermanTTS);
            } else {
                initGermanTTS();
            }
        }

        // Add audio icon with better handling
        function createAudioIcon(text) {
            return `<span class="audio-icon" onclick="event.stopPropagation(); speakGerman('${text.replace(/'/g, "\\'")}'); this.classList.add('playing'); setTimeout(() => this.classList.remove('playing'), 1000);"></span>`;
        }

        // Show home view
        function showHome() {
            currentView = 'home';
            currentUnit = null;
            currentSection = null;
            updateBreadcrumb();
            
            const mainView = document.getElementById('mainView');
            mainView.innerHTML = `
                <div class="fade-in">
                    <div class="home-search">
                        <div class="home-search-title">🔎 Suche (Startseite)</div>
                        <div class="home-search-row">
                            <input id="homeSearchInput" class="wortschatz-input" type="text"
                                   placeholder="Wort oder Thema suchen … (z. B. gehen, Schule)"
                                   oninput="updateHomeSearchResults(this.value)" />
                            <button class="btn btn-secondary" onclick="clearHomeSearch()">Leeren</button>
                        </div>
                    </div>

                    <div id="studentHomeworkContainer"></div>
                    <div id="homeUnitsContainer"></div>
                    <div id="homeSearchResultsContainer"></div>
                </div>
            `;

            renderStudentHomeworkSection();
            renderHomeUnitsGrid();
        }

        async function renderStudentHomeworkSection() {
            const container = document.getElementById('studentHomeworkContainer');
            if (!container) return;
            if (!db || !currentAuthUser?.uid || !studentInfo?.class) {
                container.innerHTML = '';
                return;
            }

            const className = normalizeClassName(studentInfo.class);
            if (!className) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = '<div class="dialogue-box">📚 Hausaufgaben werden geladen …</div>';
            try {
                const currentUid = String(currentAuthUser.uid);
                const uniqueById = {};
                const collectDocs = (docs) => {
                    docs.forEach((doc) => {
                        uniqueById[doc.id] = { id: doc.id, ...doc.data() };
                    });
                };

                let loaded = false;
                try {
                    // Preferred path for strict rules (visibleTo based)
                    const visibleSnap = await getQuerySnapshotWithAuthRetry(() =>
                        db.collection(HOMEWORK_COLLECTION).where('visibleTo', 'array-contains', currentUid)
                    );
                    collectDocs(visibleSnap.docs);
                    loaded = true;
                } catch (errVisible) {
                    console.warn('visibleTo-Abfrage fehlgeschlagen, Fallback auf target:', errVisible);
                }

                if (!loaded) {
                    try {
                        // Fallback for older homework schema (targetType/target based)
                        const [classSnap, studentSnap] = await Promise.all([
                            getQuerySnapshotWithAuthRetry(() =>
                                db.collection(HOMEWORK_COLLECTION).where('targetType', '==', 'class').where('target', '==', className)
                            ),
                            getQuerySnapshotWithAuthRetry(() =>
                                db.collection(HOMEWORK_COLLECTION).where('targetType', '==', 'student').where('target', '==', currentUid)
                            )
                        ]);
                        collectDocs(classSnap.docs);
                        collectDocs(studentSnap.docs);
                        loaded = true;
                    } catch (errTarget) {
                        console.warn('target-Abfrage fehlgeschlagen, vollständiger Lesevorgang als Fallback:', errTarget);
                    }
                }

                if (!loaded) {
                    // Last resort for permissive rules; filter client-side
                    const allSnap = await getQuerySnapshotWithAuthRetry(() => db.collection(HOMEWORK_COLLECTION));
                    allSnap.docs.forEach((doc) => {
                        const data = doc.data() || {};
                        const visibleTo = Array.isArray(data.visibleTo) ? data.visibleTo.map(String) : [];
                        const classHit = data.targetType === 'class' && String(data.target || '') === className;
                        const studentHit = data.targetType === 'student' && String(data.target || '') === currentUid;
                        if (visibleTo.includes(currentUid) || classHit || studentHit) {
                            uniqueById[doc.id] = { id: doc.id, ...data };
                        }
                    });
                }

                const homeworks = Object.values(uniqueById).sort((a, b) => {
                    const aTs = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
                    const bTs = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
                    return bTs - aTs;
                });

                if (homeworks.length === 0) {
                    container.innerHTML = `
                        <div class="unit-detail" style="margin-bottom: 1.5rem;">
                            <h3>📚 Meine Hausaufgaben</h3>
                            <div class="dialogue-box">Noch keine Hausaufgabe für dich.</div>
                        </div>
                    `;
                    return;
                }

                const progressRows = await Promise.all(
                    homeworks.map((hw) => calculateHomeworkProgressForUser(hw, currentAuthUser.uid))
                );

                container.innerHTML = `
                    <div class="unit-detail" style="margin-bottom: 1.5rem;">
                        <h3>📚 Meine Hausaufgaben (${homeworks.length})</h3>
                        ${homeworks.map((hw, idx) => {
                            const p = progressRows[idx];
                            const dateLabel = hw.createdAt?.toDate
                                ? hw.createdAt.toDate().toLocaleString('de-DE')
                                : '-';
                            const deadline = parseDeadlineDate(hw.deadlineAt);
                            const deadlineLabel = deadline ? deadline.toLocaleString('de-DE') : 'Keine Frist';
                            const targetLabel = hw.targetType === 'class'
                                ? `Klasse: ${escapeHtml(hw.target || '-')}`
                                : 'Nur für mich';
                            const progressLabel = p.isLate
                                ? `%${p.progressBeforeDeadline} (bis zur Frist)`
                                : `%${p.progressNow} erledigt`;
                            const progressValue = p.isLate ? p.progressBeforeDeadline : p.progressNow;
                            return `
                                <div class="dialogue-box" style="margin-bottom: 0.75rem;">
                                    <strong>${escapeHtml(hw.title || 'Hausaufgabe')}</strong><br>
                                    <div style="margin: 0.35rem 0 0.6rem 0;">${escapeHtml(hw.content || '')}</div>
                                    <small style="opacity: .9;">
                                        ${targetLabel} | Themenkreis: ${escapeHtml(String(hw.unitId || '-'))} | Erstellt: ${dateLabel} | Frist: ${deadlineLabel}
                                    </small>
                                    <div style="margin-top: .6rem;">
                                        <div style="font-size:.92rem; margin-bottom:.3rem;">Fortschritt: ${progressLabel} (${p.isLate ? p.completedBeforeDeadline : p.completedNow}/${p.totalContents})</div>
                                        <div class="progress-bar" style="height: 10px;">
                                            <div class="progress-fill" style="width: ${progressValue}%;">${progressValue}%</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                `;
            } catch (error) {
                console.error('Hausaufgaben konnten nicht geladen werden:', error);
                container.innerHTML = `<div class="dialogue-box">❌ Hausaufgaben: ${escapeHtml(error.message || 'Unbekannter Fehler')}</div>`;
            }
        }

        function renderHomeUnitsGrid(filterText) {
            const q = String(filterText || '').trim().toLowerCase();
            const container = document.getElementById('homeUnitsContainer');
            if (!container) return;

            const html = '<div class="units-grid">' +
                Object.keys(unitsData).filter(unitNum => {
                    if (!q) return true;
                    const unit = unitsData[unitNum];
                    const hay = `${unitNum} ${unit.title} ${unit.subtitle}`.toLowerCase();
                    return hay.includes(q);
                }).map(unitNum => {
                    const unit = unitsData[unitNum];
                    const completed = testScores[unitNum] > 0 ? '✅' : '';
                    return `
                        <div class="unit-card" style="--unit-color: ${unit.color}" onclick="showUnit(${unitNum})">
                            <div class="unit-number">${unitNum}</div>
                            <h2>Themenkreis ${unitNum} ${completed}</h2>
                            <p>${escapeHtml(unit.title)}</p>
                            <small>${escapeHtml(unit.subtitle)}</small>
                        </div>
                    `;
                }).join('') +
            '</div>';

            container.innerHTML = html;
        }

        function clearHomeSearch() {
            const input = document.getElementById('homeSearchInput');
            if (input) input.value = '';
            const res = document.getElementById('homeSearchResultsContainer');
            if (res) res.innerHTML = '';
            renderHomeUnitsGrid();
            if (input) input.focus();
        }

        function updateHomeSearchResults(value) {
            const q = String(value || '').trim().toLowerCase();
            renderHomeUnitsGrid(q);

            const container = document.getElementById('homeSearchResultsContainer');
            if (!container) return;
            if (!q) {
                container.innerHTML = '';
                return;
            }

            // search vocabulary across all units
            const matches = [];
            Object.keys(unitsData).forEach(unitNumStr => {
                const unitNum = Number(unitNumStr);
                const unit = unitsData[unitNum];
                if (!unit || !Array.isArray(unit.wortschatz)) return;
                unit.wortschatz.forEach((w, idx) => {
                    const word = (w && w.word) ? String(w.word) : '';
                    const tr = (w && w.tr) ? String(w.tr) : '';
                    const cat = (w && w.category) ? String(w.category) : 'other';
                    const hay = `${word} ${tr} ${cat} u${unitNum} ${unit.title} ${unit.subtitle}`.toLowerCase();
                    if (hay.includes(q)) {
                        matches.push({ unitNum, idx, word, tr, cat, id: `${unitNum}::${word}` });
                    }
                });
            });

            matches.sort((a, b) => {
                if (a.unitNum !== b.unitNum) return a.unitNum - b.unitNum;
                return a.idx - b.idx;
            });

            const top = matches.slice(0, 80);
            const list = top.map(m => `
                <div class="home-search-item" onclick="jumpToVocabFromHome(${m.unitNum}, '${escapeJs(m.word)}')">
                    <div style="display:flex; align-items:center; gap:0.8rem; min-width:0;">
                        <span class="unit-pill">U${m.unitNum}</span>
                        <div style="min-width:0;">
                            <div class="wortschatz-result-word">${escapeHtml(m.word)}</div>
                            <div class="wortschatz-result-tr">${escapeHtml(m.tr)}</div>
                        </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:0.6rem;">
                        <button class="fav-star-btn" title="Favorit an/aus"
                                onclick="event.stopPropagation(); toggleFavoriteVocab('${escapeJs(m.id)}'); updateHomeSearchResults(document.getElementById('homeSearchInput').value);">
                            ${isFavoriteVocab(m.id) ? '★' : '☆'}
                        </button>
                        <span class="audio-icon" onclick="event.stopPropagation(); speakGerman('${escapeJs(m.word)}'); this.classList.add('playing'); setTimeout(() => this.classList.remove('playing'), 1000);"></span>
                    </div>
                </div>
            `).join('');

            container.innerHTML = `
                <div class="home-search-results">
                    <div class="home-search-results-header">
                        <div><strong>Wortsuche:</strong> ${matches.length}</div>
                        <div style="color: var(--text-secondary); font-size: 0.95rem;">
                            ${matches.length > 80 ? 'Erste 80 werden gezeigt' : ''}
                        </div>
                    </div>
                    <div class="home-search-results-list">
                        ${list || `<div style="padding: 1rem;">Kein Ergebnis.</div>`}
                    </div>
                </div>
            `;
        }

        function jumpToVocabFromHome(unitNum, word) {
            showUnit(unitNum);
            // ensure Wortschatz UI state matches this unit and query
            initWortschatzUiState();
            window.wortschatzUiState.unitFilter = Number(unitNum);
            window.wortschatzUiState.category = 'all';
            window.wortschatzUiState.onlyFavorites = false;
            window.wortschatzUiState.query = String(word || '');

            toggleSection('wortschatz');

            // after render, jump to first match (best-effort)
            setTimeout(() => {
                const items = getFilteredWortschatzItems(window.wortschatzUiState);
                const idx = items.findIndex(it => String(it.word).toLowerCase() === String(word).toLowerCase());
                if (idx >= 0) goToFlashcard(idx);
                // keep search filled
                const input = document.getElementById('wortschatzSearchInput');
                if (input) input.value = String(word || '');
            }, 0);
        }

        // Show unit detail
        function showUnit(unitNum) {
            currentView = 'unit';
            currentUnit = unitNum;
            currentSection = null;
            updateBreadcrumb();
            
            const unit = unitsData[unitNum];
            const mainView = document.getElementById('mainView');
            
            mainView.innerHTML = `
                <div class="unit-detail fade-in">
                    <h1 style="color: ${unit.color}">Themenkreis ${unitNum}: ${unit.title}</h1>
                    <p style="font-size: 1.1rem; color: var(--text-secondary)">${unit.subtitle}</p>
                    
                    <div class="sections-grid">
                        <button class="section-btn" style="background: linear-gradient(135deg, #FF6B9D, #F38181)" onclick="toggleSection('kommunikation')">
                            💬 Kommunikation
                        </button>
                        <button class="section-btn" style="background: linear-gradient(135deg, #4ECDC4, #95E1D3)" onclick="toggleSection('wortschatz')">
                            📚 Wortschatz
                        </button>
                        <button class="section-btn" style="background: linear-gradient(135deg, #FFE66D, #FCBAD3)" onclick="toggleSection('grammatik')">
                            📖 Grammatik
                        </button>
                        <button class="section-btn" style="background: linear-gradient(135deg, #AA96DA, #FCBAD3)" onclick="toggleSection('ubungen')">
                            ✏️ Übungen
                        </button>
                        <button class="section-btn" style="background: linear-gradient(135deg, #A8E6CF, #95E1D3)" onclick="toggleSection('test')">
                            ✅ Test
                        </button>
                    </div>
                    
                    <div id="kommunikation-content" class="section-content"></div>
                    <div id="wortschatz-content" class="section-content"></div>
                    <div id="grammatik-content" class="section-content"></div>
                    <div id="ubungen-content" class="section-content"></div>
                    <div id="test-content" class="section-content"></div>
                </div>
            `;
        }

        // Toggle section content
        function toggleSection(section) {
            ['kommunikation', 'wortschatz', 'grammatik', 'ubungen', 'test'].forEach(s => {
                const content = document.getElementById(`${s}-content`);
                if (s !== section) {
                    content.classList.remove('active');
                }
            });
            
            const content = document.getElementById(`${section}-content`);
            const isActive = content.classList.contains('active');
            
            if (isActive) {
                content.classList.remove('active');
                currentSection = null;
            } else {
                content.classList.add('active');
                currentSection = section;
                renderSection(section);
                markContentCompleted(`u${currentUnit}:section:${section}`, currentUnit);
            }
            
            updateBreadcrumb();
        }

        // Render section content - FULL IMPLEMENTATION
        function renderSection(section) {
            const unit = unitsData[currentUnit];
            const content = document.getElementById(`${section}-content`);
            
            if (section === 'kommunikation') {
                const komm = unit.kommunikation;
                content.innerHTML = `
                    <h2>🗣️ Kommunikation</h2>
                    <h3>Lernziele / Öğrenme Hedefleri:</h3>
                    <ul style="font-size: 1.1rem; line-height: 2;">
                        ${komm.skills.map(skill => `<li>${skill}</li>`).join('')}
                    </ul>
                    
                    <h3>Beispiele:</h3>
                    ${komm.examples.map(ex => `
                        <div class="dialogue-box">
                            ${ex} ${createAudioIcon(ex)}
                        </div>
                    `).join('')}
                    
                    <h3>Dialog:</h3>
                    ${komm.dialogues.map(d => `
                        <div class="dialogue-box">
                            <div class="speaker">${d.speaker}:</div>
                            <div>${d.text} ${createAudioIcon(d.text)}</div>
                        </div>
                    `).join('')}
                `;
            } else if (section === 'wortschatz') {
                initWortschatzUiState();
                initFavorites();

                const wsState = window.wortschatzUiState;
                const unitFilter = wsState.unitFilter ?? currentUnit;
                const categories = getWortschatzCategories(unitFilter);

                // Store current flashcard index for the selected unit-filter scope
                if (!window.flashcardState) window.flashcardState = {};
                const stateKey = getWortschatzStateKey(unitFilter);
                if (!window.flashcardState[stateKey]) {
                    window.flashcardState[stateKey] = { index: 0, flipped: false };
                }

                const items = getFilteredWortschatzItems(wsState);
                const totalWords = items.length;
                const state = window.flashcardState[stateKey];
                if (state.index >= totalWords) {
                    state.index = 0;
                    state.flipped = false;
                }

                const currentIndex = state.index;
                const currentItem = totalWords > 0 ? items[currentIndex] : null;

                const unitOptions = [
                    `<option value="all"${String(unitFilter) === 'all' ? ' selected' : ''}>Alle Themenkreise</option>`,
                    ...Object.keys(unitsData).map(u => {
                        const selected = String(unitFilter) === String(u) ? ' selected' : '';
                        return `<option value="${u}"${selected}>Themenkreis ${u} - ${unitsData[u].title}</option>`;
                    })
                ].join('');

                const categoryOptions = [
                    `<option value="all"${wsState.category === 'all' ? ' selected' : ''}>Alle Kategorien</option>`,
                    ...categories.map(c => `<option value="${c}"${wsState.category === c ? ' selected' : ''}>${c}</option>`)
                ].join('');

                const favToggleClass = wsState.onlyFavorites ? 'fav-toggle active' : 'fav-toggle';

                const toolbarHtml = `
                    <div class="wortschatz-toolbar">
                        <div class="wortschatz-toolbar-row">
                            <input id="wortschatzSearchInput" class="wortschatz-input" type="text" autocomplete="off"
                                   placeholder="Suchen … (z. B. gehen, ich)" value="${escapeHtml(wsState.query || '')}"
                                   oninput="setWortschatzQuery(this.value)" />
                            <select class="wortschatz-select" onchange="setWortschatzUnitFilter(this.value)">
                                ${unitOptions}
                            </select>
                            <select class="wortschatz-select" onchange="setWortschatzCategory(this.value)">
                                ${categoryOptions}
                            </select>
                            <div class="${favToggleClass}" onclick="toggleWortschatzOnlyFavorites()">
                                ★ Nur Favoriten
                            </div>
                        </div>
                    </div>
                `;

                const emptyHtml = `
                    <div class="dialogue-box" style="margin-top: 1.5rem;">
                        <strong>Kein Ergebnis.</strong><br>
                        Bitte Suche oder Filter ändern.
                    </div>
                `;

                const flashcardHtml = currentItem ? `
                    <div class="flashcard-container">
                        <div style="width: 100%; max-width: 420px; display: flex; justify-content: flex-end; margin-bottom: 0.4rem;">
                            <button class="fav-star-btn" title="Favorit an/aus"
                                    onclick="event.stopPropagation(); toggleFavoriteVocab('${escapeJs(currentItem.id)}');">
                                ${isFavoriteVocab(currentItem.id) ? '★' : '☆'}
                            </button>
                        </div>
                        <div class="vocab-card ${state.flipped ? 'flipped' : ''}" id="currentFlashcard" onclick="flipFlashcard()">
                            <div class="vocab-card-inner">
                                <div class="vocab-card-front">
                                    <div class="vocab-word">
                                        ${escapeHtml(currentItem.word)}
                                    </div>
                                    <div style="margin-top: 1rem;">
                                        <span class="audio-icon" onclick="event.stopPropagation(); speakGerman('${escapeJs(currentItem.word)}'); this.classList.add('playing'); setTimeout(() => this.classList.remove('playing'), 1000);"></span>
                                    </div>
                                    <div style="text-align: center; color: var(--text-secondary); margin-top: 1.5rem; font-size: 0.95rem;">
                                        🔄 Karte klicken zum Umdrehen
                                    </div>
                                </div>
                                <div class="vocab-card-back">
                                    <div class="vocab-word" style="font-size: 2rem;">
                                        ${escapeHtml(currentItem.word)}
                                    </div>
                                    <div class="vocab-translation" style="font-size: 1.8rem; color: var(--accent-2); margin: 1rem 0;">
                                        🇹🇷 ${escapeHtml(currentItem.tr)}
                                    </div>
                                    <div style="margin-top: 1rem;">
                                        <span class="audio-icon" onclick="event.stopPropagation(); speakGerman('${escapeJs(currentItem.word)}'); this.classList.add('playing'); setTimeout(() => this.classList.remove('playing'), 1000);"></span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="flashcard-nav">
                            <button class="flashcard-nav-btn" onclick="prevFlashcard()" ${currentIndex === 0 ? 'disabled' : ''}>
                                ←
                            </button>
                            <div class="flashcard-counter">
                                ${currentIndex + 1} / ${totalWords}
                            </div>
                            <button class="flashcard-nav-btn" onclick="nextFlashcard()" ${currentIndex === totalWords - 1 ? 'disabled' : ''}>
                                →
                            </button>
                        </div>

                        <div class="flashcard-progress">
                            <div class="flashcard-progress-fill" style="width: ${totalWords ? ((currentIndex + 1) / totalWords) * 100 : 0}%"></div>
                        </div>

                        <div class="flashcard-hint">
                            ← → Mit Pfeiltasten oder Tastatur blättern
                        </div>
                    </div>
                ` : emptyHtml;

                const resultsPreview = items.slice(0, 60).map((it, idx) => `
                    <div class="wortschatz-result-item" onclick="goToFlashcard(${idx})">
                        <div class="wortschatz-result-left">
                            <button class="fav-star-btn" title="Favorit an/aus"
                                    onclick="event.stopPropagation(); toggleFavoriteVocab('${escapeJs(it.id)}'); renderSection('wortschatz');">
                                ${isFavoriteVocab(it.id) ? '★' : '☆'}
                            </button>
                            <div style="display:flex; flex-direction:column; min-width:0;">
                                <div class="wortschatz-result-word">${escapeHtml(it.word)}</div>
                                <div class="wortschatz-result-tr">${escapeHtml(it.tr)}</div>
                            </div>
                        </div>
                        <div style="display:flex; align-items:center; gap:0.6rem;">
                            <span class="unit-pill">U${it.unitNum}</span>
                            <span class="audio-icon" onclick="event.stopPropagation(); speakGerman('${escapeJs(it.word)}'); this.classList.add('playing'); setTimeout(() => this.classList.remove('playing'), 1000);"></span>
                        </div>
                    </div>
                `).join('');

                const resultsHtml = `
                    <div class="wortschatz-results">
                        <div class="wortschatz-results-header">
                            <div><strong>Ergebnisse:</strong> ${totalWords} Wörter</div>
                            <div style="color: var(--text-secondary); font-size: 0.95rem;">
                                ${totalWords > 60 ? `Erste 60 werden gezeigt` : ` `}
                            </div>
                        </div>
                        <div class="wortschatz-results-list">
                            ${resultsPreview || `<div style="padding: 1rem;">${emptyHtml}</div>`}
                        </div>
                    </div>
                `;

                content.innerHTML = `
                    <h2>📚 Wortschatz</h2>
                    ${toolbarHtml}
                    ${flashcardHtml}
                    ${resultsHtml}
                `;
                
                // Add keyboard navigation
                document.onkeydown = function(e) {
                    if (currentSection === 'wortschatz') {
                        if (e.key === 'ArrowLeft') prevFlashcard();
                        else if (e.key === 'ArrowRight') nextFlashcard();
                        else if (e.key === ' ' || e.key === 'Enter') flipFlashcard();
                    }
                };
            } else if (section === 'grammatik') {
                content.innerHTML = `
                    <h2>📖 Grammatik</h2>
                    ${unit.grammatik.map((gram, idx) => `
                        <div style="margin: 2rem 0;">
                            <h3 style="color: ${unit.color}">${idx + 1}. ${gram.topic}</h3>
                            <p style="font-size: 1.1rem; line-height: 1.8;">${gram.explanation}</p>
                            
                            <table class="grammar-table">
                                ${gram.table.map((row, rowIdx) => `
                                    <tr>
                                        ${row.map(cell => 
                                            rowIdx === 0 ? `<th>${cell}</th>` : `<td>${cell}</td>`
                                        ).join('')}
                                    </tr>
                                `).join('')}
                            </table>
                            
                            <div class="dialogue-box">
                                <strong>Beispiel:</strong><br>
                                ${gram.example} ${createAudioIcon(gram.example)}
                            </div>
                        </div>
                    `).join('')}
                `;
            } else if (section === 'ubungen') {
                renderEnhancedExercises(content);
            } else if (section === 'test') {
                renderTest(content);
            }
        }

        // Render exercises
        function renderExercises(content) {
            const exercises = generateExercises(currentUnit);
            let score = exerciseScores[currentUnit] || 0;
            
            content.innerHTML = `
                <h2>✏️ Übungen</h2>
                <div class="score-display" id="exerciseScore">Punkte: ${score}</div>
                <div id="exercisesContainer"></div>
            `;
            
            const container = document.getElementById('exercisesContainer');
            exercises.forEach((ex, idx) => {
                container.innerHTML += `
                    <div class="exercise-container">
                        <div class="exercise-question">
                            ${idx + 1}. ${ex.question}
                        </div>
                        <div class="exercise-options">
                            ${ex.options.map((opt, optIdx) => `
                                <button class="option-btn" onclick="checkAnswer(${currentUnit}, ${idx}, ${optIdx}, ${ex.correct})" id="ex${idx}-opt${optIdx}">
                                    ${opt}
                                </button>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
        }

        // Generate exercises from unit data
        function generateExercises(unitNum) {
            const unit = unitsData[unitNum];
            const exercises = [];
            
            // Generate 10 exercises from vocabulary
            const vocabSample = unit.wortschatz.sort(() => 0.5 - Math.random()).slice(0, 10);
            
            vocabSample.forEach(word => {
                const wrongAnswers = unit.wortschatz
                    .filter(w => w.word !== word.word)
                    .sort(() => 0.5 - Math.random())
                    .slice(0, 3)
                    .map(w => w.tr);
                
                const options = [word.tr, ...wrongAnswers].sort(() => 0.5 - Math.random());
                
                exercises.push({
                    question: `Was bedeutet „${word.word}“?`,
                    options: options,
                    correct: options.indexOf(word.tr)
                });
            });
            
            return exercises;
        }

        // Check answer
        function checkAnswer(unitNum, exerciseIdx, selectedIdx, correctIdx) {
            const buttons = document.querySelectorAll(`#ex${exerciseIdx}-opt0, #ex${exerciseIdx}-opt1, #ex${exerciseIdx}-opt2, #ex${exerciseIdx}-opt3`);
            
            buttons.forEach((btn, idx) => {
                btn.disabled = true;
                if (idx === correctIdx) {
                    btn.classList.add('correct');
                } else if (idx === selectedIdx) {
                    btn.classList.add('wrong');
                }
            });
            
            if (selectedIdx === correctIdx) {
                exerciseScores[unitNum] = (exerciseScores[unitNum] || 0) + 1;
                document.getElementById('exerciseScore').textContent = `Punkte: ${exerciseScores[unitNum]}`;
                markContentCompleted(`u${unitNum}:exercise:${exerciseIdx}`, unitNum);
                saveProgress();
                updateStudentInFirestore();
            }
        }

        // Render test
        function renderTest(content) {
            const questions = generateTestQuestions(currentUnit);
            
            content.innerHTML = `
                <h2>✅ Test - Themenkreis ${currentUnit}</h2>
                <p style="font-size: 1.1rem;">Beantworte zehn Fragen.</p>
                <div id="testContainer"></div>
                <button class="btn btn-primary" style="margin-top: 2rem; width: 100%;" onclick="submitTest()">
                    Test abschicken
                </button>
            `;
            
            const container = document.getElementById('testContainer');
            questions.forEach((q, idx) => {
                container.innerHTML += `
                    <div class="exercise-container">
                        <div class="exercise-question">${idx + 1}. ${q.question}</div>
                        <div class="exercise-options">
                            ${q.options.map((opt, optIdx) => `
                                <button class="option-btn" onclick="selectTestAnswer(${idx}, ${optIdx})" id="test${idx}-opt${optIdx}">
                                    ${opt}
                                </button>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
            
            window.currentTestQuestions = questions;
            window.testAnswers = [];
        }

        // Generate test questions
        function generateTestQuestions(unitNum) {
            const unit = unitsData[unitNum];
            const questions = [];
            
            // 10 random vocabulary questions
            const vocabSample = unit.wortschatz.sort(() => 0.5 - Math.random()).slice(0, 10);
            
            vocabSample.forEach(word => {
                const wrongAnswers = unit.wortschatz
                    .filter(w => w.word !== word.word)
                    .sort(() => 0.5 - Math.random())
                    .slice(0, 3)
                    .map(w => w.tr);
                
                const options = [word.tr, ...wrongAnswers].sort(() => 0.5 - Math.random());
                
                questions.push({
                    question: `Was bedeutet „${word.word}“?`,
                    options: options,
                    correct: options.indexOf(word.tr)
                });
            });
            
            return questions;
        }

        // Select test answer
        function selectTestAnswer(questionIdx, optionIdx) {
            for (let i = 0; i < 4; i++) {
                const btn = document.getElementById(`test${questionIdx}-opt${i}`);
                if (btn) {
                    btn.style.background = 'var(--card-bg)';
                    btn.style.color = 'var(--text-primary)';
                }
            }
            
            const btn = document.getElementById(`test${questionIdx}-opt${optionIdx}`);
            btn.style.background = 'var(--accent-2)';
            btn.style.color = 'white';
            
            window.testAnswers[questionIdx] = optionIdx;
        }

        // Submit test
        async function submitTest() {
            const questions = window.currentTestQuestions;
            let correct = 0;
            
            questions.forEach((q, idx) => {
                if (window.testAnswers[idx] === q.correct) {
                    correct++;
                }
            });
            
            const percentage = Math.round((correct / questions.length) * 100);
            testScores[currentUnit] = percentage;
            markContentCompleted(`u${currentUnit}:test:final`, currentUnit);
            saveProgress();
            await updateStudentInFirestore();
            updateGlobalProgress();
            checkCertificateEligibility();
            
            const messages = {
                100: "Perfekt! 🌟",
                80: "Sehr gut! 🎉",
                60: "Gut! 👍",
                40: "Weiter üben! 💪",
                0: "Noch einmal versuchen! 🌱"
            };
            
            let message = messages[0];
            for (let threshold in messages) {
                if (percentage >= threshold) {
                    message = messages[threshold];
                    break;
                }
            }
            
            const content = document.getElementById('test-content');
            content.innerHTML = `
                <div class="test-result fade-in">
                    <h2>Test-Ergebnis</h2>
                    <div class="test-score">${percentage}%</div>
                    <div class="motivational-message">${message}</div>
                    <p style="font-size: 1.2rem;">
                        ${correct} / ${questions.length} richtig
                    </p>
                    <button class="btn btn-primary" onclick="toggleSection('test')" style="margin-top: 2rem;">
                        Noch einmal
                    </button>
                </div>
            `;
        }

        // Filter vocabulary (legacy - kept for compatibility)
        function filterVocab(searchTerm) {
            const cards = document.querySelectorAll('.vocab-card');
            cards.forEach(card => {
                const text = card.textContent.toLowerCase();
                if (text.includes(searchTerm.toLowerCase())) {
                    card.style.display = 'block';
                } else {
                    card.style.display = 'none';
                }
            });
        }

        // Filter by category (legacy - kept for compatibility)
        function filterByCategory(category, event) {
            const cards = document.querySelectorAll('.vocab-card');
            const buttons = document.querySelectorAll('.filter-btn');
            
            buttons.forEach(btn => btn.classList.remove('active'));
            event.target.classList.add('active');
            
            cards.forEach(card => {
                if (category === 'all' || card.dataset.category === category) {
                    card.style.display = 'block';
                } else {
                    card.style.display = 'none';
                }
            });
        }

        // Flip vocabulary card (legacy)
        function flipCard(cardIdx) {
            const cards = document.querySelectorAll('.vocab-card');
            cards[cardIdx].classList.toggle('flipped');
        }

        // ============================================
        // NEW FLASHCARD SYSTEM
        // ============================================

        // ============================================
        // WORTSCHATZ: SEARCH / FILTER / FAVORITES
        // ============================================

        function initWortschatzUiState() {
            if (!window.wortschatzUiState) {
                window.wortschatzUiState = {
                    unitFilter: currentUnit,
                    category: 'all',
                    query: '',
                    onlyFavorites: false
                };
            } else if (window.wortschatzUiState.unitFilter == null) {
                window.wortschatzUiState.unitFilter = currentUnit;
            }
        }

        function getWortschatzStateKey(unitFilter) {
            return `ws:${unitFilter ?? currentUnit}`;
        }

        function escapeHtml(str) {
            return String(str ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function escapeJs(str) {
            return String(str ?? '')
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "\\'")
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r');
        }

        function initFavorites() {
            if (window.favoriteVocabIds) return;
            try {
                const raw = localStorage.getItem('favoriteVocabIds');
                const arr = raw ? JSON.parse(raw) : [];
                window.favoriteVocabIds = new Set(Array.isArray(arr) ? arr : []);
            } catch {
                window.favoriteVocabIds = new Set();
            }
        }

        function saveFavorites() {
            if (!window.favoriteVocabIds) return;
            try {
                localStorage.setItem('favoriteVocabIds', JSON.stringify(Array.from(window.favoriteVocabIds)));
            } catch (e) {
                console.warn('⚠️ Favoriten konnten nicht gespeichert werden:', e);
            }
            updateFavoritesInFirestoreDebounced();
        }

        let _favoritesSyncTimer = null;
        function updateFavoritesInFirestoreDebounced() {
            if (!db || !studentDocId) return;
            if (_favoritesSyncTimer) clearTimeout(_favoritesSyncTimer);
            _favoritesSyncTimer = setTimeout(async () => {
                try {
                    initFavorites();
                    await db.collection('students').doc(studentDocId).update({
                        favoriteVocabIds: Array.from(window.favoriteVocabIds),
                        lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                    });
                } catch (e) {
                    console.warn('⚠️ Favoriten in Firestore konnten nicht aktualisiert werden:', e);
                }
            }, 600);
        }

        async function loadFavoritesFromFirestore() {
            if (!db || !studentDocId) return;
            try {
                initFavorites();
                const doc = await db.collection('students').doc(studentDocId).get();
                if (!doc.exists) return;
                const data = doc.data() || {};
                const arr = Array.isArray(data.favoriteVocabIds) ? data.favoriteVocabIds : [];
                // Merge: keep local favorites too
                arr.forEach(id => window.favoriteVocabIds.add(String(id)));
                saveFavorites(); // persists merged result and schedules Firestore update
            } catch (e) {
                console.warn('⚠️ Favoriten konnten nicht aus Firestore gelesen werden:', e);
            }
        }

        function isFavoriteVocab(id) {
            initFavorites();
            return window.favoriteVocabIds.has(id);
        }

        function toggleFavoriteVocab(id) {
            initFavorites();
            if (window.favoriteVocabIds.has(id)) window.favoriteVocabIds.delete(id);
            else window.favoriteVocabIds.add(id);
            saveFavorites();
        }

        let _wsQueryTimer = null;
        function setWortschatzQuery(value) {
            initWortschatzUiState();
            const input = document.getElementById('wortschatzSearchInput');
            const selStart = input && typeof input.selectionStart === 'number' ? input.selectionStart : null;
            const selEnd = input && typeof input.selectionEnd === 'number' ? input.selectionEnd : null;

            window.wortschatzUiState.query = value ?? '';
            const stateKey = getWortschatzStateKey(window.wortschatzUiState.unitFilter);
            if (window.flashcardState && window.flashcardState[stateKey]) {
                window.flashcardState[stateKey].index = 0;
                window.flashcardState[stateKey].flipped = false;
            }

            if (_wsQueryTimer) clearTimeout(_wsQueryTimer);
            _wsQueryTimer = setTimeout(() => {
                renderSection('wortschatz');
                // restore focus after rerender (prevents "re-click each char" issue)
                requestAnimationFrame(() => {
                    const nextInput = document.getElementById('wortschatzSearchInput');
                    if (nextInput) {
                        nextInput.focus();
                        if (selStart != null && selEnd != null) {
                            try { nextInput.setSelectionRange(selStart, selEnd); } catch {}
                        }
                    }
                });
            }, 120);
        }

        function setWortschatzCategory(value) {
            initWortschatzUiState();
            window.wortschatzUiState.category = value || 'all';
            const stateKey = getWortschatzStateKey(window.wortschatzUiState.unitFilter);
            if (window.flashcardState && window.flashcardState[stateKey]) {
                window.flashcardState[stateKey].index = 0;
                window.flashcardState[stateKey].flipped = false;
            }
            renderSection('wortschatz');
        }

        function setWortschatzUnitFilter(value) {
            initWortschatzUiState();
            window.wortschatzUiState.unitFilter = (value === 'all') ? 'all' : Number(value);
            window.wortschatzUiState.category = 'all';
            const stateKey = getWortschatzStateKey(window.wortschatzUiState.unitFilter);
            if (!window.flashcardState) window.flashcardState = {};
            if (!window.flashcardState[stateKey]) {
                window.flashcardState[stateKey] = { index: 0, flipped: false };
            } else {
                window.flashcardState[stateKey].index = 0;
                window.flashcardState[stateKey].flipped = false;
            }
            renderSection('wortschatz');
        }

        function toggleWortschatzOnlyFavorites() {
            initWortschatzUiState();
            window.wortschatzUiState.onlyFavorites = !window.wortschatzUiState.onlyFavorites;
            const stateKey = getWortschatzStateKey(window.wortschatzUiState.unitFilter);
            if (window.flashcardState && window.flashcardState[stateKey]) {
                window.flashcardState[stateKey].index = 0;
                window.flashcardState[stateKey].flipped = false;
            }
            renderSection('wortschatz');
        }

        function getWortschatzCategories(unitFilter) {
            const cats = new Set();
            const unitNums = (unitFilter === 'all')
                ? Object.keys(unitsData).map(Number)
                : [Number(unitFilter ?? currentUnit)];

            unitNums.forEach(u => {
                const unit = unitsData[u];
                if (!unit || !Array.isArray(unit.wortschatz)) return;
                unit.wortschatz.forEach(w => {
                    const c = (w && w.category) ? String(w.category) : 'other';
                    cats.add(c);
                });
            });

            return Array.from(cats).sort((a, b) => a.localeCompare(b));
        }

        function getFilteredWortschatzItems(wsState) {
            initWortschatzUiState();
            initFavorites();

            const unitFilter = wsState.unitFilter ?? currentUnit;
            const unitNums = (unitFilter === 'all')
                ? Object.keys(unitsData).map(Number)
                : [Number(unitFilter)];

            const q = String(wsState.query || '').trim().toLowerCase();
            const category = wsState.category || 'all';
            const onlyFav = !!wsState.onlyFavorites;

            const items = [];
            unitNums.forEach(unitNum => {
                const unit = unitsData[unitNum];
                if (!unit || !Array.isArray(unit.wortschatz)) return;
                unit.wortschatz.forEach((w, idx) => {
                    const word = (w && w.word) ? String(w.word) : '';
                    const tr = (w && w.tr) ? String(w.tr) : '';
                    const cat = (w && w.category) ? String(w.category) : 'other';
                    const id = `${unitNum}::${word}`;

                    if (category !== 'all' && cat !== category) return;
                    if (onlyFav && !window.favoriteVocabIds.has(id)) return;
                    if (q) {
                        const hay = `${word} ${tr} ${cat} u${unitNum}`.toLowerCase();
                        if (!hay.includes(q)) return;
                    }

                    items.push({ id, unitNum, index: idx, word, tr, category: cat });
                });
            });

            items.sort((a, b) => {
                if (a.unitNum !== b.unitNum) return a.unitNum - b.unitNum;
                return a.index - b.index;
            });

            return items;
        }
        
        // Flip current flashcard
        function flipFlashcard() {
            const card = document.getElementById('currentFlashcard');
            if (card) {
                card.classList.toggle('flipped');
                if (window.flashcardState && window.flashcardState[currentUnit]) {
                    window.flashcardState[currentUnit].flipped = card.classList.contains('flipped');
                }
            }
        }
        
        // Go to next flashcard
        function nextFlashcard() {
            if (!currentUnit || !window.flashcardState) return;
            
            initWortschatzUiState();
            const stateKey = getWortschatzStateKey(window.wortschatzUiState.unitFilter ?? currentUnit);
            const totalWords = getFilteredWortschatzItems(window.wortschatzUiState).length;
            const state = window.flashcardState[stateKey];
            if (!state) return;
            
            if (state.index < totalWords - 1) {
                state.index++;
                state.flipped = false;
                renderSection('wortschatz');
            }
        }
        
        // Go to previous flashcard
        function prevFlashcard() {
            if (!currentUnit || !window.flashcardState) return;
            
            initWortschatzUiState();
            const stateKey = getWortschatzStateKey(window.wortschatzUiState.unitFilter ?? currentUnit);
            const state = window.flashcardState[stateKey];
            if (!state) return;
            
            if (state.index > 0) {
                state.index--;
                state.flipped = false;
                renderSection('wortschatz');
            }
        }
        
        // Go to specific flashcard
        function goToFlashcard(index) {
            if (!currentUnit || !window.flashcardState) return;
            
            initWortschatzUiState();
            const stateKey = getWortschatzStateKey(window.wortschatzUiState.unitFilter ?? currentUnit);
            const totalWords = getFilteredWortschatzItems(window.wortschatzUiState).length;
            
            if (index >= 0 && index < totalWords) {
                if (!window.flashcardState[stateKey]) {
                    window.flashcardState[stateKey] = { index: 0, flipped: false };
                }
                window.flashcardState[stateKey].index = index;
                window.flashcardState[stateKey].flipped = false;
                markContentCompleted(`u${currentUnit}:wortschatz:${index}`, currentUnit);
                renderSection('wortschatz');
            }
        }

        // Show leaderboard with real-time Firebase data
        async function showLeaderboard() {
            currentView = 'leaderboard';
            updateBreadcrumb();
            
            const mainView = document.getElementById('mainView');
            mainView.innerHTML = `
                <div class="unit-detail fade-in">
                    <h1 style="color: var(--accent-1)">🏆 Global Leaderboard</h1>
                    <p style="font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 2rem;">
                        Live-Rangliste aller Schülerinnen und Schüler
                    </p>
                    <div class="loading">Daten werden geladen …</div>
                </div>
            `;
            
            if (!db) {
                mainView.innerHTML = `
                    <div class="unit-detail fade-in">
                        <h1>🏆 Leaderboard</h1>
                        <div class="dialogue-box">
                            <strong>⚠️ Firebase ist nicht konfiguriert.</strong>
                        </div>
                    </div>
                `;
                return;
            }
            
            try {
                // Real-time listener
                db.collection('students')
                    .orderBy('totalPoints', 'desc')
                    .onSnapshot((snapshot) => {
                        const students = [];
                        snapshot.forEach((doc) => {
                            const data = doc.data();
                            // Exclude admins from leaderboard
                            const docEmail = normalizeEmail(data.email || '');
                            const isAdminDoc = !!docEmail && (adminEmails || []).map(normalizeEmail).includes(docEmail);
                            if (!isAdminDoc) students.push({ id: doc.id, ...data });
                        });
                        
                        renderLeaderboard(students);
                    });
            } catch (error) {
                console.error('❌ Leaderboard konnte nicht geladen werden:', error);
                mainView.innerHTML += `<div class="dialogue-box"><strong>❌ Fehler:</strong> ${error.message}</div>`;
            }
        }

        // Render leaderboard table
        function renderLeaderboard(students) {
            const mainView = document.getElementById('mainView');
            
            mainView.innerHTML = `
                <div class="unit-detail fade-in">
                    <h1 style="color: var(--accent-1)">🏆 Global Leaderboard</h1>
                    <p style="font-size: 1.1rem; color: var(--text-secondary); margin-bottom: 2rem;">
                        Insgesamt ${students.length} Schülerinnen und Schüler
                    </p>
                    
                    <table class="leaderboard-table">
                        <thead>
                            <tr>
                                <th>Platz</th>
                                <th>Name</th>
                                <th>Klasse</th>
                                <th>Nr.</th>
                                <th>Themenkreise</th>
                                <th>Ø %</th>
                                <th>Punkte</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${students.map((student, index) => {
                                const rank = index + 1;
                                const rankClass = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-other';
                                const isCurrentUser = student.id === studentDocId;
                                
                                return `
                                    <tr style="${isCurrentUser ? 'background: rgba(78, 205, 196, 0.2); font-weight: bold;' : ''}">
                                        <td>
                                            <span class="rank-badge ${rankClass}">${rank}</span>
                                        </td>
                                        <td>${student.fullName} ${isCurrentUser ? '👤' : ''}</td>
                                        <td>${student.class}</td>
                                        <td>${student.number}</td>
                                        <td>${(student.completedUnits || []).length} / 9</td>
                                        <td>${student.averageScore || 0}%</td>
                                        <td><strong>${student.totalPoints || 0}</strong></td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                    
                    <button class="btn btn-secondary" onclick="showHome()" style="margin-top: 2rem;">
                        🏠 Startseite
                    </button>
                </div>
            `;
        }

        // Show profile
        function showProfile() {
            currentView = 'profile';
            updateBreadcrumb();
            
            if (!studentInfo) {
                alert('Bitte zuerst deine Profildaten eingeben.');
                return;
            }
            
            const completedUnits = Object.keys(testScores).filter(key => testScores[key] > 0).length;
            const totalUnitCount = Object.keys(unitsData).length;
            const totalPoints = Object.values(exerciseScores).reduce((a, b) => a + b, 0);
            const avgScore = completedUnits > 0 
                ? Math.round(Object.values(testScores).reduce((a, b) => a + b, 0) / completedUnits)
                : 0;
            
            const badges = calculateBadges(completedUnits, avgScore, totalPoints, totalUnitCount);
            
            const mainView = document.getElementById('mainView');
            mainView.innerHTML = `
                <div class="fade-in">
                    <div class="profile-header">
                        <div class="profile-avatar">👨‍🎓</div>
                        <h1>${studentInfo.fullName}</h1>
                        <p style="font-size: 1.2rem; margin-top: 0.5rem;">
                            Klasse: ${studentInfo.class} | Nr.: ${studentInfo.number}
                        </p>
                    </div>
                    
                    <div class="profile-stats">
                        <div class="stat-card">
                            <div class="stat-value">${completedUnits}</div>
                            <div class="stat-label">Themenkreise mit Test</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${avgScore}%</div>
                            <div class="stat-label">Durchschnitt</div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-value">${totalPoints}</div>
                            <div class="stat-label">Punkte gesamt</div>
                        </div>
                    </div>
                    
                    <div class="unit-detail">
                        <h2>🏅 Abzeichen</h2>
                        <div class="badge-container">
                            ${badges.map(badge => `
                                <div class="badge ${badge.unlocked ? '' : 'locked'}" onclick='showBadgeModal(${JSON.stringify(badge)})' style="cursor: pointer;">
                                    <div class="badge-icon">${badge.icon}</div>
                                    <div class="badge-title">${badge.title}</div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    
                    <div class="unit-detail">
                        <h2>📚 Deine Themenkreise</h2>
                        ${Object.keys(unitsData).map(unitNum => {
                            const unit = unitsData[unitNum];
                            const testScore = testScores[unitNum] || 0;
                            const exerciseScore = exerciseScores[unitNum] || 0;
                            const completed = testScore > 0;
                            return `
                                <div class="dialogue-box" style="margin: 1rem 0;">
                                    <h3 style="color: ${unit.color}">
                                        ${completed ? '✅' : '⏳'} Themenkreis ${unitNum}: ${unit.title}
                                    </h3>
                                    <p>Test: <strong>${testScore}%</strong></p>
                                    <p>Übungen (Punkte): <strong>${exerciseScore}</strong></p>
                                </div>
                            `;
                        }).join('')}
                    </div>
                    
                    <div style="text-align: center; margin-top: 2rem;">
                        ${avgScore >= 60 && completedUnits === totalUnitCount ? `
                            <button class="btn btn-gold" onclick="showCertificate()" style="font-size: 1.2rem; padding: 1rem 2rem;">
                                🎓 Zertifikat anzeigen
                            </button>
                        ` : `
                            <div class="dialogue-box">
                                <strong>ℹ️ Für das Zertifikat:</strong><br>
                                – Alle ${totalUnitCount} Themenkreise mit Test (${completedUnits}/${totalUnitCount})<br>
                                – Mindestens 60 % Durchschnitt (du: ${avgScore}%)
                            </div>
                        `}
                        <br>
                        <button class="btn btn-secondary" onclick="showHome()" style="margin-top: 1rem;">
                            🏠 Startseite
                        </button>
                        <br>
                        <button class="delete-account-btn" onclick="deleteMyAccount()">
                            🗑️ Konto löschen
                        </button>
                    </div>
                </div>
            `;
        }

        // Check certificate eligibility
        function checkCertificateEligibility() {
            const totalUnits = Object.keys(unitsData).length;
            const completedTests = Object.keys(testScores).filter(key => testScores[key] > 0).length;
            const avgScore = completedTests > 0 
                ? Object.values(testScores).reduce((a, b) => a + b, 0) / completedTests
                : 0;
            
            const certBtn = document.getElementById('certificateBtn');
            if (completedTests === totalUnits && avgScore >= 60) {
                certBtn.classList.remove('hidden');
            } else {
                certBtn.classList.add('hidden');
            }
        }

        // Show certificate
        function showCertificate() {
            currentView = 'certificate';
            updateBreadcrumb();
            
            const completedTests = Object.keys(testScores).filter(key => testScores[key] > 0).length;
            const avgScore = completedTests > 0 
                ? Math.round(Object.values(testScores).reduce((a, b) => a + b, 0) / completedTests)
                : 0;
            const date = new Date().toLocaleDateString('de-DE');
            
            const mainView = document.getElementById('mainView');
            mainView.innerHTML = `
                <div class="certificate fade-in">
                    <div class="ornament">🏆</div>
                    <h1>German A1 Certificate</h1>
                    <h2>Deutschzertifikat A1</h2>
                    
                    <p style="font-size: 1.3rem; margin: 2rem 0;">
                        Hiermit wird bestätigt:
                    </p>
                    
                    <div class="student-name">${studentInfo.fullName}</div>
                    
                    <div class="details">
                        <p><strong>Klasse:</strong> ${studentInfo.class}</p>
                        <p><strong>Nummer:</strong> ${studentInfo.number}</p>
                        <p><strong>Datum:</strong> ${date}</p>
                        <p><strong>Ergebnis:</strong> ${avgScore}%</p>
                    </div>
                    
                    <p style="font-size: 1.2rem; margin: 2rem 0;">
                        hat den Deutsch-A1-Kurs mit ${Object.keys(unitsData).length} Themenkreisen erfolgreich abgeschlossen.
                    </p>
                    
                    <div class="signature">
                        🎓 Deutsch Lernen A1 Platform
                    </div>
                    
                    <div style="margin-top: 3rem; display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap;">
                        <button class="btn btn-primary" onclick="window.print()">
                            🖨️ Drucken / PDF
                        </button>
                        <button class="btn btn-secondary" onclick="showHome()">
                            🏠 Startseite
                        </button>
                    </div>
                </div>
            `;
        }

        // TEACHER PANEL
        function showTeacherPanel() {
            if (!isTeacher) return;
            
            currentView = 'teacher';
            updateBreadcrumb();
            
            const mainView = document.getElementById('mainView');
            mainView.innerHTML = `
                <div class="teacher-panel fade-in">
                    <h2>👨‍🏫 Lehrerbereich</h2>
                    <p>
                        Hallo, ${studentInfo.fullName}
                        ${normalizeEmail(currentAuthUser?.email) ? `(<strong>${normalizeEmail(currentAuthUser?.email)}</strong>)` : ''}
                    </p>
                    <div class="dialogue-box" style="margin: 1rem 0; background: rgba(255,255,255,0.15);">
                        <strong>Admin debug:</strong>
                        isTeacher=${isTeacher ? 'true' : 'false'} |
                        adminEmailsLoaded=${Array.isArray(adminEmails) ? adminEmails.length : 0}
                    </div>
                    
                    <div class="teacher-tabs">
                        <button class="teacher-tab active" onclick="showTeacherTab('students')">📊 Schülerinnen und Schüler</button>
                        <button class="teacher-tab" onclick="showTeacherTab('homeworks')">📨 Hausaufgaben</button>
                        <button class="teacher-tab" onclick="showTeacherTab('content')">📝 Inhalt bearbeiten</button>
                        <button class="teacher-tab" onclick="showTeacherTab('wortschatz')">📚 Wortschatz-Editor</button>
                        <button class="teacher-tab" onclick="showTeacherTab('certificates')">🎓 Zertifikate</button>
                        <button class="teacher-tab" onclick="showTeacherTab('settings')">⚙️ Einstellungen</button>
                    </div>
                    
                    <div id="teacherContent"></div>
                </div>
            `;
            
            showTeacherTab('students');
        }

        async function showTeacherTab(tab) {
            const content = document.getElementById('teacherContent');
            const tabs = document.querySelectorAll('.teacher-tab');
            tabs.forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            
            if (tab === 'students') {
                content.innerHTML = '<div class="loading">Schülerliste wird geladen …</div>';
                
                try {
                    const snapshot = await db.collection('students').get();
                    const students = [];
                    snapshot.forEach(doc => students.push({ id: doc.id, ...doc.data() }));
                    
                    content.innerHTML = `
                        <div class="unit-detail">
                            <h3>Schülerliste (${students.length})</h3>
                            <table class="leaderboard-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Klasse</th>
                                        <th>Punkte</th>
                                        <th>Themenkreise</th>
                                        <th>Aktion</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${students.map(s => `
                                        <tr>
                                            <td>${s.fullName}</td>
                                            <td>${s.class}</td>
                                            <td>${s.totalPoints || 0}</td>
                                            <td>${(s.completedUnits || []).length}/${Object.keys(unitsData).length}</td>
                                            <td>
                                                <button class="btn btn-primary" onclick="resetStudentProgress('${s.id}')">Fortschritt zurücksetzen</button>
                                                <button class="btn btn-primary" onclick="deleteStudentCompletely('${s.id}', '${s.fullName}')" style="background: linear-gradient(135deg, #E74C3C, #C0392B); margin-left: 0.5rem;">
                                                    Vollständig löschen
                                                </button>
                                            </td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                        </div>
                    `;
                } catch (error) {
                    content.innerHTML = `<div class="dialogue-box">❌ Fehler: ${error.message}</div>`;
                }
            } else if (tab === 'homeworks') {
                await renderTeacherHomeworkTab(content);
            } else if (tab === 'content') {
                content.innerHTML = `
                    <div class="unit-detail">
                        <h3>🎨 Inhalte verwalten</h3>
                        <p>Hier kannst du die Inhalte der Themenkreise bearbeiten.</p>
                        <div class="form-group">
                            <label>Themenkreis:</label>
                            <select class="input-field" id="unitSelectTeacher" onchange="loadUnitForEdit(this.value)">
                                <option value="">Bitte wählen …</option>
                                ${Object.keys(unitsData).map(u => `<option value="${u}">Themenkreis ${u} - ${unitsData[u].title}</option>`).join('')}
                            </select>
                        </div>
                        <div id="unitEditArea"></div>
                    </div>
                `;
            } else if (tab === 'wortschatz') {
                content.innerHTML = `
                    <div class="unit-detail">
                        <h3>📚 Wortschatz-Editor</h3>
                        <p>Karten pro Themenkreis bearbeiten, hinzufügen oder löschen.</p>
                        <div class="form-group">
                            <label>Themenkreis:</label>
                            <select class="input-field" id="vocabUnitSelect" onchange="loadWortschatzEditor(this.value)">
                                <option value="">Bitte wählen …</option>
                                ${Object.keys(unitsData).map(u => `<option value="${u}">Themenkreis ${u} - ${unitsData[u].title}</option>`).join('')}
                            </select>
                        </div>
                        <div id="wortschatzEditArea"></div>
                    </div>
                `;
            } else if (tab === 'certificates') {
                content.innerHTML = '<div class="loading">Zertifikate werden geladen …</div>';
                
                try {
                    const snapshot = await db.collection('students')
                        .where('completedUnits', '!=', [])
                        .get();
                    const eligibleStudents = [];
                    snapshot.forEach(doc => {
                        const data = doc.data();
                        const avgScore = (data.completedUnits || []).length > 0 
                            ? Object.values(data.testScores || {}).reduce((a, b) => a + b, 0) / (data.completedUnits || []).length
                            : 0;
                        if ((data.completedUnits || []).length === Object.keys(unitsData).length && avgScore >= 60) {
                            eligibleStudents.push({ id: doc.id, ...data, avgScore: Math.round(avgScore) });
                        }
                    });
                    
                    content.innerHTML = `
                        <div class="unit-detail">
                            <h3>Zertifikate (${eligibleStudents.length})</h3>
                            ${eligibleStudents.length > 0 ? `
                                <table class="leaderboard-table">
                                    <thead>
                                        <tr>
                                            <th>Name</th>
                                            <th>Klasse</th>
                                            <th>Ergebnis %</th>
                                            <th>Datum</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${eligibleStudents.map(s => `
                                            <tr>
                                                <td>${s.fullName}</td>
                                                <td>${s.class}</td>
                                                <td>${s.avgScore}%</td>
                                                <td>${new Date(s.createdAt).toLocaleDateString('de-DE')}</td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            ` : '<p>Noch keine Schülerin / kein Schüler mit Zertifikat.</p>'}
                        </div>
                    `;
                } catch (error) {
                    content.innerHTML = `<div class="dialogue-box">❌ Fehler: ${error.message}</div>`;
                }
            } else if (tab === 'settings') {
                content.innerHTML = `
                    <div class="unit-detail">
                        <h3>⚙️ Einstellungen</h3>
                        <div class="form-group">
                            <label>Dark Mode:</label>
                            <button class="btn btn-dark" onclick="toggleDarkMode()">Wechseln</button>
                        </div>
                        <div class="form-group">
                            <label>Anzahl Testfragen:</label>
                            <input type="number" class="input-field" value="10" disabled>
                        </div>
                        <div class="unit-detail admin-manage-card" style="margin-top: 1.5rem;">
                            <h3>🔐 Admins (E-Mail)</h3>
                            <p style="color: var(--text-secondary); margin-bottom: 1rem;">
                                Diese E-Mails haben vollen Zugriff auf den Lehrerbereich.
                            </p>

                            <div class="admin-manage-row">
                                <input id="adminEmailInput" type="email" class="input-field" placeholder="admin@schule.de">
                                <button class="btn btn-primary" onclick="addAdminEmailFromInput()">➕ Hinzufügen</button>
                                <button class="btn btn-secondary" onclick="saveAdminEmailsToFirestore()">💾 Speichern</button>
                            </div>

                            <div id="adminEmailsList" class="admin-emails-list"></div>
                            <div id="adminManageMessage" class="dialogue-box" style="display:none; margin-top: 1rem;"></div>
                        </div>
                    </div>
                `;
                renderAdminEmailsList();
            }
        }

        async function renderTeacherHomeworkTab(content) {
            content.innerHTML = '<div class="loading">Formular wird geladen …</div>';
            try {
                const snapshot = await db.collection('students').get();
                const students = [];
                snapshot.forEach((doc) => {
                    const data = doc.data() || {};
                    if (data.uid) students.push({ id: doc.id, ...data });
                });
                students.sort((a, b) => String(a.fullName || '').localeCompare(String(b.fullName || ''), 'de'));

                content.innerHTML = `
                    <div class="unit-detail">
                        <h3>📨 Hausaufgaben senden</h3>
                        <p>Für eine ganze Klasse oder für eine Schülerin / einen Schüler.</p>

                        <div class="dialogue-box" style="margin-bottom: 1rem;">
                            <strong>1) An die Klasse</strong>
                            <form onsubmit="sendHomeworkFromTeacherTab(event, 'class')">
                                <div class="form-group">
                                    <label>Klasse</label>
                                    <select id="homeworkClassTarget" class="input-field" required>
                                        <option value="">Klasse wählen …</option>
                                        ${ALLOWED_CLASSES.map((className) => `<option value="${className}">${className}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label>Themenkreis</label>
                                    <select id="homeworkClassUnitId" class="input-field" required>
                                        <option value="">Themenkreis wählen …</option>
                                        ${Object.keys(unitsData).map((u) => `<option value="${u}">Themenkreis ${u} - ${escapeHtml(unitsData[u].title || '')}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label>Titel</label>
                                    <input type="text" id="homeworkClassTitle" class="input-field" required>
                                </div>
                                <div class="form-group">
                                    <label>Text</label>
                                    <textarea id="homeworkClassContent" class="input-field" rows="4" required></textarea>
                                </div>
                                <div class="form-group">
                                    <label>Abgabe bis</label>
                                    <input type="datetime-local" id="homeworkClassDeadline" class="input-field" required>
                                </div>
                                <button class="btn btn-primary" type="submit">Senden</button>
                            </form>
                        </div>

                        <div class="dialogue-box">
                            <strong>2) Für eine Person</strong>
                            <form onsubmit="sendHomeworkFromTeacherTab(event, 'student')">
                                <div class="form-group">
                                    <label>Schülerin / Schüler</label>
                                    <select id="homeworkStudentTarget" class="input-field" required>
                                        <option value="">Person wählen …</option>
                                        ${students.map((s) => `
                                            <option value="${s.uid}">
                                                ${escapeHtml(s.fullName || 'Ohne Name')} - ${escapeHtml(normalizeClassName(s.class) || '-')}
                                            </option>
                                        `).join('')}
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label>Themenkreis</label>
                                    <select id="homeworkStudentUnitId" class="input-field" required>
                                        <option value="">Themenkreis wählen …</option>
                                        ${Object.keys(unitsData).map((u) => `<option value="${u}">Themenkreis ${u} - ${escapeHtml(unitsData[u].title || '')}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="form-group">
                                    <label>Titel</label>
                                    <input type="text" id="homeworkStudentTitle" class="input-field" required>
                                </div>
                                <div class="form-group">
                                    <label>Text</label>
                                    <textarea id="homeworkStudentContent" class="input-field" rows="4" required></textarea>
                                </div>
                                <div class="form-group">
                                    <label>Abgabe bis</label>
                                    <input type="datetime-local" id="homeworkStudentDeadline" class="input-field" required>
                                </div>
                                <button class="btn btn-primary" type="submit">Senden</button>
                            </form>
                        </div>

                        <div class="unit-detail" style="margin-top: 1rem;">
                            <h3>📊 Hausaufgaben – Überblick</h3>
                            <div id="teacherHomeworkAnalytics">Wird geladen …</div>
                        </div>
                    </div>
                `;
                await renderTeacherHomeworkAnalytics(students);
            } catch (error) {
                content.innerHTML = `<div class="dialogue-box">❌ Formular: ${escapeHtml(error.message || 'Unbekannter Fehler')}</div>`;
            }
        }

        async function renderTeacherHomeworkAnalytics(students) {
            const root = document.getElementById('teacherHomeworkAnalytics');
            if (!root) return;
            if (!db) {
                root.innerHTML = '<div class="dialogue-box">Keine Firebase-Verbindung.</div>';
                return;
            }
            try {
                const hwSnap = await db.collection(HOMEWORK_COLLECTION).orderBy('createdAt', 'desc').limit(12).get();
                const homeworks = hwSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
                    .filter((h) => getUnitIdValue(h.unitId));
                if (homeworks.length === 0) {
                    root.innerHTML = '<div class="dialogue-box">Noch keine Hausaufgaben mit Themenkreis.</div>';
                    return;
                }
                const studentByUid = {};
                (students || []).forEach((s) => {
                    if (s.uid) studentByUid[s.uid] = s;
                });

                const blocks = [];
                for (const hw of homeworks) {
                    const recipients = Array.isArray(hw.visibleTo) ? Array.from(new Set(hw.visibleTo.map(String))) : [];
                    if (recipients.length === 0) continue;
                    const rows = [];
                    for (const uid of recipients) {
                        const p = await calculateHomeworkProgressForUser(hw, uid);
                        rows.push({ uid, ...p });
                    }
                    const avgNow = progressPercent(rows.reduce((sum, r) => sum + (r.progressNow || 0), 0), rows.length || 1);
                    const avgDeadline = progressPercent(rows.reduce((sum, r) => sum + (r.progressBeforeDeadline || 0), 0), rows.length || 1);
                    const topRows = [...rows].sort((a, b) => (b.progressNow - a.progressNow)).slice(0, 3);
                    const deadlineDate = parseDeadlineDate(hw.deadlineAt);
                    blocks.push(`
                        <div class="dialogue-box" style="margin-bottom: .9rem;">
                            <strong>${escapeHtml(hw.title || 'Hausaufgabe')}</strong><br>
                            <small>Themenkreis: ${escapeHtml(String(hw.unitId || '-'))} | Frist: ${deadlineDate ? deadlineDate.toLocaleString('de-DE') : 'Keine Frist'}</small>
                            <div style="margin-top:.45rem;">Klassen-Durchschnitt (jetzt): <strong>%${avgNow}</strong> | Bis zur Frist: <strong>%${avgDeadline}</strong></div>
                            <div style="margin-top:.35rem;">Top Fortschritt: ${topRows.map((r) => {
                                const name = escapeHtml(studentByUid[r.uid]?.fullName || r.uid);
                                return `${name} (%${r.progressNow})`;
                            }).join(', ') || '-'}</div>
                            <div style="margin-top:.55rem;">
                                ${rows.map((r) => {
                                    const studentName = escapeHtml(studentByUid[r.uid]?.fullName || r.uid);
                                    const fixedValue = r.isLate ? r.progressBeforeDeadline : r.progressNow;
                                    return `
                                        <div style="margin-bottom:.45rem;">
                                            <div style="font-size:.9rem;">${studentName} - %${fixedValue}${r.isLate ? ' (Stand bei Frist)' : ''}</div>
                                            <div class="progress-bar" style="height: 8px;">
                                                <div class="progress-fill" style="width:${fixedValue}%;">${fixedValue}%</div>
                                            </div>
                                        </div>
                                    `;
                                }).join('')}
                            </div>
                        </div>
                    `);
                }
                root.innerHTML = blocks.join('') || '<div class="dialogue-box">Zu wenig Daten für die Auswertung.</div>';
            } catch (error) {
                root.innerHTML = `<div class="dialogue-box">❌ Auswertung: ${escapeHtml(error.message || 'Unbekannter Fehler')}</div>`;
            }
        }

        async function sendHomeworkFromTeacherTab(event, targetType) {
            event.preventDefault();
            if (!isTeacher) {
                alert('Nur Lehrkräfte können Hausaufgaben erstellen.');
                return;
            }
            if (!db || !currentAuthUser?.uid) {
                alert('Die Datenbank ist nicht bereit.');
                return;
            }

            const isClassTarget = targetType === 'class';
            const targetInputId = isClassTarget ? 'homeworkClassTarget' : 'homeworkStudentTarget';
            const titleInputId = isClassTarget ? 'homeworkClassTitle' : 'homeworkStudentTitle';
            const contentInputId = isClassTarget ? 'homeworkClassContent' : 'homeworkStudentContent';
            const unitInputId = isClassTarget ? 'homeworkClassUnitId' : 'homeworkStudentUnitId';
            const deadlineInputId = isClassTarget ? 'homeworkClassDeadline' : 'homeworkStudentDeadline';

            const rawTarget = document.getElementById(targetInputId)?.value || '';
            const title = (document.getElementById(titleInputId)?.value || '').trim();
            const contentValue = (document.getElementById(contentInputId)?.value || '').trim();
            const unitId = getUnitIdValue(document.getElementById(unitInputId)?.value || '');
            const deadlineValue = document.getElementById(deadlineInputId)?.value || '';
            const deadlineDate = deadlineValue ? new Date(deadlineValue) : null;

            if (!title || !contentValue || !rawTarget || !unitId || !deadlineDate || Number.isNaN(deadlineDate.getTime())) {
                alert('Bitte alle Felder ausfüllen.');
                return;
            }

            const target = isClassTarget ? normalizeClassName(rawTarget) : String(rawTarget).trim();
            if (isClassTarget && !target) {
                alert('Bitte eine gültige Klasse wählen.');
                return;
            }

            try {
                let visibleTo = [];
                if (isClassTarget) {
                    const studentsInClass = await db.collection('students').where('class', '==', target).get();
                    studentsInClass.forEach((doc) => {
                        const uid = String(doc.data()?.uid || '').trim();
                        if (uid) visibleTo.push(uid);
                    });
                } else {
                    visibleTo = [target];
                }
                visibleTo = Array.from(new Set(visibleTo));

                await db.collection(HOMEWORK_COLLECTION).add({
                    title,
                    content: contentValue,
                    targetType: isClassTarget ? 'class' : 'student',
                    target,
                    unitId,
                    deadlineAt: firebase.firestore.Timestamp.fromDate(deadlineDate),
                    visibleTo,
                    createdBy: currentAuthUser.uid,
                    createdAt: firebase.firestore.FieldValue.serverTimestamp()
                });
                await ensureUnitDocument(unitId);

                document.getElementById(titleInputId).value = '';
                document.getElementById(contentInputId).value = '';
                document.getElementById(deadlineInputId).value = '';
                if (!isClassTarget) {
                    document.getElementById(targetInputId).selectedIndex = 0;
                }
                alert('✅ Hausaufgabe gesendet.');
            } catch (error) {
                console.error('Hausaufgabe senden fehlgeschlagen:', error);
                alert(`❌ Hausaufgabe konnte nicht gesendet werden: ${error.message}`);
            }
        }

        function setAdminManageMessage(message, type = 'info') {
            const el = document.getElementById('adminManageMessage');
            if (!el) return;
            if (!message) {
                el.style.display = 'none';
                el.textContent = '';
                return;
            }
            el.style.display = 'block';
            const palette = {
                info: 'rgba(78, 205, 196, 0.15)',
                success: 'rgba(46, 204, 113, 0.15)',
                error: 'rgba(231, 76, 60, 0.15)'
            };
            el.style.background = palette[type] || palette.info;
            el.textContent = message;
        }

        function renderAdminEmailsList() {
            const listEl = document.getElementById('adminEmailsList');
            if (!listEl) return;
            const emails = (adminEmails || []).map(normalizeEmail).filter(Boolean);
            const unique = Array.from(new Set(emails));
            adminEmails = unique;

            if (unique.length === 0) {
                listEl.innerHTML = `<div class="dialogue-box">Noch keine Admin-E-Mail.</div>`;
                return;
            }

            const myEmail = normalizeEmail(currentAuthUser?.email || '');
            listEl.innerHTML = `
                <div class="admin-email-items">
                    ${unique.map((email) => {
                        const isMe = myEmail && email === myEmail;
                        return `
                            <div class="admin-email-item">
                                <div class="admin-email-text">
                                    <strong>${email}</strong> ${isMe ? '<span class="teacher-badge" style="margin-left: .5rem;">SEN</span>' : ''}
                                </div>
                                <button class="btn btn-secondary admin-email-remove"
                                    onclick="removeAdminEmail('${email}')"
                                    ${isMe ? 'disabled title="Du kannst dich nicht selbst entfernen"' : ''}>
                                    🗑️ Entfernen
                                </button>
                            </div>
                        `;
                    }).join('')}
                </div>
            `;
        }

        function addAdminEmailFromInput() {
            const input = document.getElementById('adminEmailInput');
            if (!input) return;
            const value = normalizeEmail(input.value);
            if (!value || !value.includes('@')) {
                setAdminManageMessage('Bitte eine gültige E-Mail eingeben.', 'error');
                return;
            }
            adminEmails = Array.from(new Set([...(adminEmails || []).map(normalizeEmail), value]));
            input.value = '';
            setAdminManageMessage('E-Mail zur Liste hinzugefügt. Bitte speichern.', 'success');
            renderAdminEmailsList();
        }

        function removeAdminEmail(email) {
            const target = normalizeEmail(email);
            const myEmail = normalizeEmail(currentAuthUser?.email || '');
            if (target && myEmail && target === myEmail) {
                setAdminManageMessage('Du kannst dich nicht selbst entfernen.', 'error');
                return;
            }
            adminEmails = (adminEmails || []).map(normalizeEmail).filter((e) => e && e !== target);
            setAdminManageMessage('E-Mail aus der Liste entfernt. Bitte speichern.', 'success');
            renderAdminEmailsList();
        }

        async function saveAdminEmailsToFirestore() {
            if (!isTeacher) {
                setAdminManageMessage('Nur für Admins.', 'error');
                return;
            }
            if (!db) {
                setAdminManageMessage('Keine Firebase-Verbindung.', 'error');
                return;
            }
            try {
                const unique = Array.from(new Set((adminEmails || []).map(normalizeEmail).filter(Boolean)));
                if (unique.length === 0) {
                    setAdminManageMessage('Mindestens eine Admin-E-Mail nötig.', 'error');
                    return;
                }
                await db.collection(ADMIN_CONFIG_PATH.collection).doc(ADMIN_CONFIG_PATH.doc).set({
                    emails: unique,
                    lastUpdated: new Date().toISOString(),
                    updatedBy: normalizeEmail(currentAuthUser?.email || studentInfo?.email || '')
                }, { merge: true });
                adminEmails = unique;
                setAdminManageMessage('Admin-Liste gespeichert.', 'success');
                await refreshAdminState();
                renderAdminEmailsList();
            } catch (e) {
                console.error('Admin listesi kaydedilemedi:', e);
                setAdminManageMessage(`Speichern fehlgeschlagen: ${e.message}`, 'error');
            }
        }

        async function resetStudentProgress(studentId) {
            if (!isTeacher) {
                alert('❌ Nur für Lehrkräfte.');
                return;
            }
            
            if (!confirm('Fortschritt dieser Person wirklich zurücksetzen?')) return;
            
            try {
                await db.collection('students').doc(studentId).update({
                    completedUnits: [],
                    totalPoints: 0,
                    averageScore: 0,
                    testScores: {},
                    exerciseScores: {},
                    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
                });
                alert('✅ Fortschritt wurde zurückgesetzt.');
                
                // Refresh the list
                showTeacherPanel();
                setTimeout(() => {
                    const studentsTab = document.querySelector('.teacher-tab');
                    if (studentsTab) studentsTab.click();
                }, 300);
            } catch (error) {
                console.error('❌ Zurücksetzen fehlgeschlagen:', error);
                alert('❌ Fehler: ' + error.message + '\n\nBitte die Firestore-Regeln prüfen.');
            }
        }

        // Update breadcrumb
        function updateBreadcrumb() {
            const breadcrumb = document.getElementById('breadcrumb');
            let html = '<a onclick="showHome()">🏠 Startseite</a>';
            
            if (currentView === 'certificate') {
                html += ' &gt; <span>🎓 Zertifikat</span>';
            } else if (currentView === 'leaderboard') {
                html += ' &gt; <span>🏆 Leaderboard</span>';
            } else if (currentView === 'profile') {
                html += ' &gt; <span>👤 Profil</span>';
            } else if (currentView === 'teacher') {
                html += ' &gt; <span>👨‍🏫 Lehrerbereich</span>';
            } else if (currentUnit) {
                const unit = unitsData[currentUnit];
                html += ` &gt; <a onclick="showUnit(${currentUnit})">Themenkreis ${currentUnit}</a>`;
                if (currentSection) {
                    const names = {
                        kommunikation: 'Kommunikation',
                        wortschatz: 'Wortschatz',
                        grammatik: 'Grammatik',
                        ubungen: 'Übungen',
                        test: 'Test'
                    };
                    html += ` &gt; <span>${names[currentSection]}</span>`;
                }
            }
            
            breadcrumb.innerHTML = html;
        }

        // Update global progress
        function updateGlobalProgress() {
            const totalUnits = Object.keys(unitsData).length;
            const completedTests = Object.keys(testScores).filter(key => testScores[key] > 0).length;
            const percentage = Math.round((completedTests / totalUnits) * 100);
            
            const progressFill = document.querySelector('.progress-fill');
            progressFill.style.width = percentage + '%';
            progressFill.textContent = percentage + '%';
        }

        // Toggle dark mode
        function toggleDarkMode() {
            darkMode = !darkMode;
            document.body.classList.toggle('dark-mode');
            localStorage.setItem('darkMode', darkMode);
        }

        // Save progress
        function saveProgress() {
            localStorage.setItem('exerciseScores', JSON.stringify(exerciseScores));
            localStorage.setItem('testScores', JSON.stringify(testScores));
        }

        // Load progress
        function loadProgress() {
            const savedDarkMode = localStorage.getItem('darkMode');
            if (savedDarkMode === 'true') {
                darkMode = true;
                document.body.classList.add('dark-mode');
            }
            
            const savedExerciseScores = localStorage.getItem('exerciseScores');
            if (savedExerciseScores) {
                exerciseScores = JSON.parse(savedExerciseScores);
            }
            
            const savedTestScores = localStorage.getItem('testScores');
            if (savedTestScores) {
                testScores = JSON.parse(savedTestScores);
            }
        }

        // Reset progress
        function resetProgress() {
            if (confirm('Gesamten Fortschritt wirklich löschen?')) {
                localStorage.removeItem('exerciseScores');
                localStorage.removeItem('testScores');
                exerciseScores = {};
                testScores = {};
                updateGlobalProgress();
                checkCertificateEligibility();
                if (studentDocId && db) {
                    updateStudentInFirestore();
                }
                alert('✅ Fortschritt wurde gelöscht.');
                showHome();
            }
        }

        // Delete student account completely
        async function deleteMyAccount() {
            if (!confirm('⚠️ Achtung: Dein Konto und alle Daten werden dauerhaft gelöscht.\n\nWirklich fortfahren?')) {
                return;
            }
            
            if (!confirm('Das kann nicht rückgängig gemacht werden. Konto WIRKLICH endgültig löschen?')) {
                return;
            }
            
            try {
                // Delete from Firestore
                if (studentDocId && db) {
                    await db.collection('students').doc(studentDocId).delete();
                    console.log('✅ Firestore-Eintrag gelöscht');
                }

                // Try deleting auth user too
                if (auth && auth.currentUser) {
                    try {
                        await auth.currentUser.delete();
                    } catch (authErr) {
                        console.warn('⚠️ Auth-Benutzer konnte nicht gelöscht werden (erneute Anmeldung nötig):', authErr);
                    }
                }
                
                // Clear localStorage
                localStorage.clear();
                
                // Reset state
                studentInfo = null;
                studentDocId = null;
                exerciseScores = {};
                testScores = {};
                
                alert('✅ Konto wurde gelöscht.');
                
                if (auth) {
                    await auth.signOut();
                } else {
                    window.location.reload();
                }
            } catch (error) {
                console.error('❌ Konto löschen fehlgeschlagen:', error);
                alert('❌ Fehler: ' + error.message);
            }
        }

        // Delete student from teacher panel (complete deletion)
        async function deleteStudentCompletely(studentId, studentName) {
            if (!confirm(`⚠️ ${studentName} wirklich vollständig aus der Rangliste entfernen?\n\nDas kann nicht rückgängig gemacht werden.`)) {
                return;
            }
            
            try {
                await db.collection('students').doc(studentId).delete();
                alert('✅ Eintrag wurde gelöscht.');
                showTeacherTab('students');
            } catch (error) {
                alert('❌ Fehler: ' + error.message);
            }
        }

        // Enhanced badge system with modal
        function showBadgeModal(badge) {
            const modal = document.createElement('div');
            modal.innerHTML = `
                <div class="badge-modal-overlay" onclick="this.parentElement.remove()"></div>
                <div class="badge-modal">
                    <div class="badge-modal-icon">${badge.icon}</div>
                    <h3>${badge.title}</h3>
                    <p style="font-size: 1.1rem; line-height: 1.8; color: var(--text-secondary);">
                        ${badge.description}
                    </p>
                    <p style="margin-top: 1rem; font-weight: 600; color: ${badge.unlocked ? 'var(--success)' : 'var(--error)'};">
                        ${badge.unlocked ? '✅ Freigeschaltet' : '🔒 Gesperrt'}
                    </p>
                    <button class="btn btn-secondary" onclick="this.closest('div').parentElement.remove()" style="width: 100%; margin-top: 1rem;">
                        Schließen
                    </button>
                </div>
            `;
            document.body.appendChild(modal);
        }

        // Calculate badges - ENHANCED with 12 badges
        function calculateBadges(completedUnits, avgScore, totalPoints, totalUnitCount) {
            const n = totalUnitCount || Object.keys(unitsData).length;
            return [
                { 
                    icon: '🌟', 
                    title: 'Erster Schritt', 
                    unlocked: completedUnits >= 1,
                    description: 'Du hast den ersten Themenkreis geschafft. Gut gemacht!'
                },
                { 
                    icon: '🔥', 
                    title: 'Dranbleiben', 
                    unlocked: completedUnits >= 4,
                    description: 'Vier Themenkreise sind fertig. Du bleibst dran.'
                },
                { 
                    icon: '🏆', 
                    title: 'Champion', 
                    unlocked: completedUnits === n,
                    description: 'Alle Themenkreise sind fertig. Stark!'
                },
                { 
                    icon: '💯', 
                    title: '100 %', 
                    unlocked: avgScore === 100,
                    description: '100 % im Durchschnitt. Perfekt!'
                },
                { 
                    icon: '⭐', 
                    title: 'Stern', 
                    unlocked: avgScore >= 80,
                    description: '80 % oder mehr – sehr gut!'
                },
                { 
                    icon: '📚', 
                    title: 'Wortschatz-Fan', 
                    unlocked: totalPoints >= 100,
                    description: 'Über 100 Punkte bei den Übungen.'
                },
                { 
                    icon: '🎯', 
                    title: 'Ziel klar', 
                    unlocked: completedUnits >= 6,
                    description: 'Sechs Themenkreise sind fertig.'
                },
                { 
                    icon: '💪', 
                    title: 'Training', 
                    unlocked: totalPoints >= 50,
                    description: 'Über 50 Punkte bei den Übungen.'
                },
                { 
                    icon: '🚀', 
                    title: 'Schnell', 
                    unlocked: completedUnits >= 3 && avgScore >= 75,
                    description: 'Drei Themenkreise und 75 % oder mehr.'
                },
                { 
                    icon: '🎓', 
                    title: 'Sehr gut', 
                    unlocked: avgScore >= 90 && completedUnits >= 5,
                    description: '90 % oder mehr und fünf Themenkreise.'
                },
                { 
                    icon: '🤖', 
                    title: 'Vielseitig', 
                    unlocked: totalPoints >= 150,
                    description: 'Über 150 Punkte bei den Übungen.'
                },
                { 
                    icon: '👑', 
                    title: 'Top', 
                    unlocked: completedUnits === n && avgScore >= 95,
                    description: 'Alle Themenkreise mit 95 % oder mehr.'
                }
            ];
        }

        // Load unit for editing in teacher panel - FULL DESIGNER MODE
        function loadUnitForEdit(unitNum) {
            if (!unitNum) return;
            
            const unit = unitsData[unitNum];
            const editArea = document.getElementById('unitEditArea');
            
            editArea.innerHTML = `
                <div class="unit-detail" style="margin-top: 2rem;">
                    <h3>🎨 Themenkreis ${unitNum}: ${unit.title} – Bearbeiten</h3>
                    
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
                        <div class="form-group">
                            <label>📝 Titel (Deutsch):</label>
                            <input type="text" class="input-field" id="edit_title" value="${unit.title}">
                        </div>
                        
                        <div class="form-group">
                            <label>📌 Untertitel:</label>
                            <input type="text" class="input-field" id="edit_subtitle" value="${unit.subtitle}">
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>🎨 Themefarbe:</label>
                        <input type="color" class="input-field" id="edit_color" value="${unit.color}" style="height: 50px; width: 100px;">
                    </div>
                    
                    <hr style="margin: 2rem 0; border-color: rgba(255,255,255,0.2);">
                    
                    <h4>🗣️ Kommunikation – Lernziele / Öğrenme Hedefleri</h4>
                    <div class="form-group">
                        <textarea class="input-field" id="edit_skills" rows="5">${unit.kommunikation.skills.join('\n')}</textarea>
                        <small>Eine Zeile pro Lernziel</small>
                    </div>
                    
                    <h4>💬 Beispiele</h4>
                    <div class="form-group">
                        <textarea class="input-field" id="edit_examples" rows="5">${unit.kommunikation.examples.join('\n')}</textarea>
                        <small>Eine Zeile pro Beispiel</small>
                    </div>
                    
                    <h4>🎭 Dialoge</h4>
                    <div id="dialogueEditList">
                        ${unit.kommunikation.dialogues.map((d, idx) => `
                            <div class="dialogue-box" style="margin: 0.5rem 0; display: grid; grid-template-columns: 150px 1fr auto; gap: 0.5rem; align-items: center;">
                                <input type="text" class="input-field" value="${d.speaker}" id="dialogue_speaker_${idx}" placeholder="Sprecher/in">
                                <input type="text" class="input-field" value="${d.text}" id="dialogue_text_${idx}" placeholder="Text">
                                <button class="btn btn-secondary" onclick="removeDialogue(${idx})" style="padding: 0.5rem;">❌</button>
                            </div>
                        `).join('')}
                    </div>
                    <button class="btn btn-secondary" onclick="addNewDialogue()" style="margin-top: 0.5rem;">
                        ➕ Dialog hinzufügen
                    </button>
                    
                    <hr style="margin: 2rem 0; border-color: rgba(255,255,255,0.2);">
                    
                    <h4>📖 Grammatik – Themen</h4>
                    <div id="grammarEditList">
                        ${unit.grammatik.map((g, idx) => `
                            <div class="dialogue-box" style="margin: 1rem 0; padding: 1rem;">
                                <div class="form-group">
                                    <label>Thema ${idx + 1}:</label>
                                    <input type="text" class="input-field" value="${g.topic}" id="grammar_topic_${idx}">
                                </div>
                                <div class="form-group">
                                    <label>Erklärung:</label>
                                    <textarea class="input-field" id="grammar_explanation_${idx}" rows="2">${g.explanation}</textarea>
                                </div>
                                <div class="form-group">
                                    <label>Beispiel:</label>
                                    <input type="text" class="input-field" value="${g.example}" id="grammar_example_${idx}">
                                </div>
                            </div>
                        `).join('')}
                    </div>
                    
                    <hr style="margin: 2rem 0; border-color: rgba(255,255,255,0.2);">
                    
                    <div style="display: flex; gap: 1rem; flex-wrap: wrap;">
                        <button class="btn btn-primary" onclick="saveUnitChangesToFirestore(${unitNum})" style="font-size: 1.2rem; flex: 1;">
                            💾 In Firestore speichern und veröffentlichen
                        </button>
                        <button class="btn btn-secondary" onclick="loadUnitForEdit(${unitNum})" style="flex: 0 0 auto;">
                            🔄 Zurücksetzen
                        </button>
                    </div>
                    
                    <p style="margin-top: 1rem; font-size: 0.9rem; color: white; text-align: center;">
                        ℹ️ Änderungen werden in Firestore gespeichert und für alle sofort sichtbar.
                    </p>
                </div>
            `;
        }

        // Wortschatz Editor - Unlimited Cards
        function loadWortschatzEditor(unitNum) {
            if (!unitNum) return;
            
            const unit = unitsData[unitNum];
            const editArea = document.getElementById('wortschatzEditArea');
            
            editArea.innerHTML = `
                <div class="unit-detail" style="margin-top: 2rem;">
                    <h3>📚 Themenkreis ${unitNum} – Wortschatz-Editor</h3>
                    <p>Insgesamt <strong>${unit.wortschatz.length}</strong> Karten</p>
                    
                    <div id="vocabCardsList" style="max-height: 500px; overflow-y: auto; padding: 1rem; background: rgba(0,0,0,0.2); border-radius: 10px;">
                        ${unit.wortschatz.map((w, idx) => `
                            <div class="vocab-edit-row" id="vocabRow_${idx}" style="display: grid; grid-template-columns: 40px 1fr 1fr auto; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;">
                                <span style="color: var(--text-secondary); text-align: center;">${idx + 1}</span>
                                <input type="text" class="input-field vocab-de" value="${w.word}" placeholder="Deutsch">
                                <input type="text" class="input-field vocab-tr" value="${w.tr}" placeholder="Übersetzung">
                                <button class="btn btn-secondary" onclick="removeVocabCard(${unitNum}, ${idx})" style="padding: 0.5rem; background: linear-gradient(135deg, #E74C3C, #C0392B);">❌</button>
                            </div>
                        `).join('')}
                    </div>
                    
                    <div style="margin-top: 1.5rem; display: flex; gap: 1rem; flex-wrap: wrap;">
                        <button class="btn btn-secondary" onclick="addNewVocabCard(${unitNum})" style="flex: 1;">
                            ➕ Neue Karte
                        </button>
                        <button class="btn btn-secondary" onclick="addMultipleVocabCards(${unitNum})" style="flex: 1;">
                            ➕➕ Fünf Karten
                        </button>
                    </div>
                    
                    <button class="btn btn-primary" onclick="saveWortschatzToFirestore(${unitNum})" style="width: 100%; margin-top: 2rem; font-size: 1.2rem;">
                        💾 Wortschatz speichern
                    </button>
                </div>
            `;
        }

        // Add new vocab card
        function addNewVocabCard(unitNum) {
            const unit = unitsData[unitNum];
            const newIdx = unit.wortschatz.length;
            
            // Add empty card to data
            unit.wortschatz.push({ word: '', tr: '', category: '' });
            
            // Add to UI
            const list = document.getElementById('vocabCardsList');
            const newRow = document.createElement('div');
            newRow.className = 'vocab-edit-row';
            newRow.id = `vocabRow_${newIdx}`;
            newRow.style.cssText = 'display: grid; grid-template-columns: 40px 1fr 1fr auto; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center;';
            newRow.innerHTML = `
                <span style="color: var(--text-secondary); text-align: center;">${newIdx + 1}</span>
                <input type="text" class="input-field vocab-de" value="" placeholder="Deutsch">
                <input type="text" class="input-field vocab-tr" value="" placeholder="Übersetzung">
                <button class="btn btn-secondary" onclick="removeVocabCard(${unitNum}, ${newIdx})" style="padding: 0.5rem; background: linear-gradient(135deg, #E74C3C, #C0392B);">❌</button>
            `;
            list.appendChild(newRow);
            
            // Scroll to new card
            list.scrollTop = list.scrollHeight;
            
            // Focus on new input
            newRow.querySelector('.vocab-de').focus();
        }

        // Add multiple vocab cards
        function addMultipleVocabCards(unitNum) {
            for (let i = 0; i < 5; i++) {
                addNewVocabCard(unitNum);
            }
        }

        // Remove vocab card
        function removeVocabCard(unitNum, idx) {
            if (!confirm('Diese Karte wirklich löschen?')) return;
            
            const unit = unitsData[unitNum];
            unit.wortschatz.splice(idx, 1);
            
            // Reload the editor
            loadWortschatzEditor(unitNum);
        }

        // Save Wortschatz to Firestore
        async function saveWortschatzToFirestore(unitNum) {
            if (!db) {
                alert('❌ Keine Firebase-Verbindung.');
                return;
            }
            
            try {
                const rows = document.querySelectorAll('.vocab-edit-row');
                const newVocab = [];
                
                rows.forEach((row, idx) => {
                    const deInput = row.querySelector('.vocab-de');
                    const trInput = row.querySelector('.vocab-tr');
                    
                    if (deInput && trInput && deInput.value.trim()) {
                        newVocab.push({
                            word: deInput.value.trim(),
                            tr: trInput.value.trim(),
                            category: ''
                        });
                    }
                });
                
                // Update local data
                unitsData[unitNum].wortschatz = newVocab;
                
                // Save to Firestore
                const contentDoc = db.collection('content').doc('units');
                await contentDoc.set({
                    [unitNum]: {
                        wortschatz: newVocab,
                        lastUpdated: new Date().toISOString(),
                        updatedBy: studentInfo ? studentInfo.fullName : 'unknown'
                    }
                }, { merge: true });
                
                alert(`✅ Wortschatz gespeichert! (${newVocab.length} Karten)`);
                
                // Reset flashcard state for this unit
                if (window.flashcardState && window.flashcardState[unitNum]) {
                    window.flashcardState[unitNum].index = 0;
                    window.flashcardState[unitNum].flipped = false;
                }
                
            } catch (error) {
                console.error('❌ Speichern fehlgeschlagen:', error);
                alert('❌ Fehler: ' + error.message);
            }
        }

        // Add new dialogue
        function addNewDialogue() {
            const list = document.getElementById('dialogueEditList');
            const idx = list.children.length;
            
            const newRow = document.createElement('div');
            newRow.className = 'dialogue-box';
            newRow.style.cssText = 'margin: 0.5rem 0; display: grid; grid-template-columns: 150px 1fr auto; gap: 0.5rem; align-items: center;';
            newRow.innerHTML = `
                <input type="text" class="input-field" value="" id="dialogue_speaker_${idx}" placeholder="Sprecher/in">
                <input type="text" class="input-field" value="" id="dialogue_text_${idx}" placeholder="Text">
                <button class="btn btn-secondary" onclick="this.parentElement.remove()" style="padding: 0.5rem;">❌</button>
            `;
            list.appendChild(newRow);
            newRow.querySelector('input').focus();
        }

        // Remove dialogue
        function removeDialogue(idx) {
            const row = document.getElementById(`dialogue_speaker_${idx}`).parentElement;
            row.remove();
        }

        // Save unit changes to Firestore - FIXED: No nested arrays
        async function saveUnitChangesToFirestore(unitNum) {
            if (!db) {
                alert('❌ Keine Firebase-Verbindung.');
                return;
            }
            
            if (!isTeacher) {
                alert('❌ Nur für Lehrkräfte.');
                return;
            }
            
            try {
                // Show loading state
                const saveBtn = event.target;
                const originalText = saveBtn.textContent;
                saveBtn.textContent = '⏳ Wird gespeichert …';
                saveBtn.disabled = true;
                
                // Collect all changes from form
                const title = document.getElementById('edit_title').value;
                const subtitle = document.getElementById('edit_subtitle').value;
                const color = document.getElementById('edit_color').value;
                const skills = document.getElementById('edit_skills').value.split('\n').filter(s => s.trim());
                const examples = document.getElementById('edit_examples').value.split('\n').filter(e => e.trim());
                
                // Collect vocabulary changes
                const updatedVocab = [];
                for (let i = 0; i < 10; i++) {
                    const deEl = document.getElementById(`vocab_de_${i}`);
                    const trEl = document.getElementById(`vocab_tr_${i}`);
                    const catEl = document.getElementById(`vocab_cat_${i}`);
                    
                    if (deEl && trEl && catEl && deEl.value.trim()) {
                        updatedVocab.push({
                            word: deEl.value.trim(),
                            tr: trEl.value.trim(),
                            category: catEl.value.trim()
                        });
                    }
                }
                
                // Keep rest of the vocabulary unchanged
                const restVocab = unitsData[unitNum].wortschatz.slice(10);
                const allVocab = [...updatedVocab, ...restVocab];
                
                // Update local data first
                unitsData[unitNum].title = title;
                unitsData[unitNum].subtitle = subtitle;
                unitsData[unitNum].color = color;
                unitsData[unitNum].kommunikation.skills = skills;
                unitsData[unitNum].kommunikation.examples = examples;
                unitsData[unitNum].wortschatz = allVocab;
                
                // Prepare Firestore-safe data (NO NESTED ARRAYS)
                const firestoreData = {
                    title: title,
                    subtitle: subtitle,
                    color: color,
                    kommunikation: {
                        skills: skills,
                        examples: examples,
                        // Convert dialogues to safe format
                        dialogues: convertDialoguesForFirestore(unitsData[unitNum].kommunikation.dialogues)
                    },
                    // Vocabulary is already array of objects - safe
                    wortschatz: allVocab,
                    // Convert grammatik tables to safe format
                    grammatik: convertGrammatikForFirestore(unitsData[unitNum].grammatik),
                    // Metadata
                    lastUpdated: new Date().toISOString(),
                    updatedBy: studentInfo ? studentInfo.fullName : 'unknown'
                };
                
                console.log('📤 Daten für Firestore:', firestoreData);
                
                // Save to Firestore with merge
                const contentDoc = db.collection('content').doc('units');
                await contentDoc.set({
                    [unitNum]: firestoreData
                }, { merge: true });
                
                console.log('✅ Firestore-Speichern erfolgreich');
                
                // Restore button
                saveBtn.textContent = '✅ Gespeichert!';
                setTimeout(() => {
                    saveBtn.textContent = originalText;
                    saveBtn.disabled = false;
                }, 2000);
                
                alert('✅ Gespeichert! Alle Nutzer sehen die Änderung sofort.');
                
                // Reload the unit to show changes
                showUnit(unitNum);
                
            } catch (error) {
                console.error('❌ Speichern fehlgeschlagen:', error);
                console.error('Details:', error.message);
                
                // Restore button on error
                if (event && event.target) {
                    event.target.textContent = '💾 In Firestore speichern und veröffentlichen';
                    event.target.disabled = false;
                }
                
                alert('❌ Speichern fehlgeschlagen!\n\n' + error.message + '\n\nBitte erneut versuchen.');
            }
        }

        // Enhanced Übungen with different exercise types
        function renderEnhancedExercises(content) {
            const unit = unitsData[currentUnit];
            let score = exerciseScores[currentUnit] || 0;
            
            const exerciseTypes = [
                {
                    type: 'multiple',
                    title: 'Multiple Choice',
                    icon: '📝'
                },
                {
                    type: 'matching',
                    title: 'Zuordnen',
                    icon: '🔗'
                },
                {
                    type: 'truefalse',
                    title: 'Richtig oder falsch?',
                    icon: '✓✗'
                }
            ];
            
            content.innerHTML = `
                <h2>✏️ Übungen</h2>
                <div class="score-display" id="exerciseScore">Punkte: ${score}</div>
                
                ${exerciseTypes.map(et => `
                    <div class="unit-detail" style="margin: 2rem 0;">
                        <h3>${et.icon} ${et.title}</h3>
                        <div id="${et.type}Container"></div>
                    </div>
                `).join('')}
            `;
            
            // Generate different exercise types
            generateMultipleChoiceEx();
            generateMatchingEx();
            generateTrueFalseEx();
        }

        function generateMultipleChoiceEx() {
            const unit = unitsData[currentUnit];
            const container = document.getElementById('multipleContainer');
            const vocab = unit.wortschatz.slice(0, 3);
            
            let html = '';
            vocab.forEach((word, idx) => {
                const wrong = unit.wortschatz.filter(w => w.word !== word.word).sort(() => 0.5 - Math.random()).slice(0, 3);
                const options = [word.tr, ...wrong.map(w => w.tr)].sort(() => 0.5 - Math.random());
                
                html += `
                    <div class="exercise-container">
                        <div class="exercise-question">${idx + 1}. Was bedeutet „${word.word}“?</div>
                        <div class="exercise-options">
                            ${options.map((opt, optIdx) => `
                                <button class="option-btn" onclick="checkExAnswer('multi${idx}', ${optIdx}, ${options.indexOf(word.tr)})" 
                                        id="multi${idx}-${optIdx}">${opt}</button>
                            `).join('')}
                        </div>
                    </div>
                `;
            });
            container.innerHTML = html;
        }

        function generateMatchingEx() {
            const container = document.getElementById('matchingContainer');
            const unit = unitsData[currentUnit];
            const vocab = unit.wortschatz.slice(0, 4);
            
            const leftSide = vocab.map(v => v.word).sort(() => 0.5 - Math.random());
            const rightSide = vocab.map(v => ({ word: v.word, tr: v.tr })).sort(() => 0.5 - Math.random());
            
            container.innerHTML = `
                <div class="match-container">
                    <div>
                        <h4>Almanca</h4>
                        ${leftSide.map((w, idx) => `
                            <div class="match-item" onclick="selectMatch('left', ${idx}, '${w}')" id="leftMatch${idx}">
                                ${w}
                            </div>
                        `).join('')}
                    </div>
                    <div>
                        <h4>Übersetzung</h4>
                        ${rightSide.map((w, idx) => `
                            <div class="match-item" onclick="selectMatch('right', ${idx}, '${w.word}')" id="rightMatch${idx}">
                                ${w.tr}
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div id="matchResult" style="text-align: center; margin-top: 1rem;"></div>
            `;
        }

        let matchSelection = { left: null, right: null, leftWord: null, rightWord: null };

        function selectMatch(side, idx, word) {
            // Deselect previous
            document.querySelectorAll('.match-item.selected').forEach(el => {
                if (!el.classList.contains('matched')) {
                    el.classList.remove('selected');
                }
            });
            
            const el = document.getElementById(`${side}Match${idx}`);
            if (el.classList.contains('matched')) return;
            
            el.classList.add('selected');
            matchSelection[side] = idx;
            matchSelection[side + 'Word'] = word;
            
            if (matchSelection.left !== null && matchSelection.right !== null) {
                if (matchSelection.leftWord === matchSelection.rightWord) {
                    document.getElementById(`leftMatch${matchSelection.left}`).classList.add('matched');
                    document.getElementById(`rightMatch${matchSelection.right}`).classList.add('matched');
                    document.getElementById('matchResult').innerHTML = '<p style="color: var(--success); font-weight: bold;">✅ Richtig!</p>';
                    
                    exerciseScores[currentUnit] = (exerciseScores[currentUnit] || 0) + 1;
                    updateExerciseScore();
                } else {
                    document.getElementById('matchResult').innerHTML = '<p style="color: var(--error); font-weight: bold;">❌ Noch einmal versuchen!</p>';
                    setTimeout(() => {
                        document.querySelectorAll('.match-item.selected:not(.matched)').forEach(el => el.classList.remove('selected'));
                    }, 1000);
                }
                
                matchSelection = { left: null, right: null, leftWord: null, rightWord: null };
            }
        }

        function generateTrueFalseEx() {
            const container = document.getElementById('truefalseContainer');
            const unit = unitsData[currentUnit];
            
            const statements = [
                { text: `„${unit.wortschatz[0].word}“ heißt: ${unit.wortschatz[0].tr}.`, correct: true },
                { text: `„${unit.wortschatz[1].word}“ heißt: ${unit.wortschatz[2].tr}.`, correct: false }
            ];
            
            container.innerHTML = statements.map((stmt, idx) => `
                <div class="exercise-container">
                    <div class="exercise-question">${idx + 1}. ${stmt.text}</div>
                    <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                        <button class="option-btn" onclick="checkTrueFalse(${idx}, true, ${stmt.correct})" id="tf${idx}True">
                            ✓ Richtig
                        </button>
                        <button class="option-btn" onclick="checkTrueFalse(${idx}, false, ${stmt.correct})" id="tf${idx}False">
                            ✗ Falsch
                        </button>
                    </div>
                </div>
            `).join('');
        }

        function checkExAnswer(id, selected, correct) {
            const buttons = document.querySelectorAll(`[id^="${id}-"]`);
            buttons.forEach((btn, idx) => {
                btn.disabled = true;
                if (idx === correct) {
                    btn.classList.add('correct');
                } else if (idx === selected) {
                    btn.classList.add('wrong');
                }
            });
            
            if (selected === correct) {
                exerciseScores[currentUnit] = (exerciseScores[currentUnit] || 0) + 1;
                const idxMatch = String(id).match(/^multi(\d+)/);
                if (idxMatch) {
                    markContentCompleted(`u${currentUnit}:exercise:${idxMatch[1]}`, currentUnit);
                }
                updateExerciseScore();
            }
        }

        function checkTrueFalse(idx, answer, correct) {
            const trueBtn = document.getElementById(`tf${idx}True`);
            const falseBtn = document.getElementById(`tf${idx}False`);
            
            trueBtn.disabled = true;
            falseBtn.disabled = true;
            
            if (answer === correct) {
                (answer ? trueBtn : falseBtn).classList.add('correct');
                exerciseScores[currentUnit] = (exerciseScores[currentUnit] || 0) + 1;
                markContentCompleted(`u${currentUnit}:exercise:truefalse:${idx}`, currentUnit);
                updateExerciseScore();
            } else {
                (answer ? trueBtn : falseBtn).classList.add('wrong');
                (!answer ? trueBtn : falseBtn).classList.add('correct');
            }
        }

        function updateExerciseScore() {
            const scoreEl = document.getElementById('exerciseScore');
            if (scoreEl) {
                scoreEl.textContent = `Punkte: ${exerciseScores[currentUnit] || 0}`;
            }
            saveProgress();
            updateStudentInFirestore();
        }

        // Initialize auth gate on load
        window.addEventListener('load', initAuthGate);
