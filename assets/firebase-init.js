        // Firebase Configuration
        const firebaseConfig = {
          apiKey: "AIzaSyC7XirzJ9KvnnN57ZwPE5LfzITrHcG3tl0",
          authDomain: "almancason.firebaseapp.com",
          projectId: "almancason",
          storageBucket: "almancason.firebasestorage.app",
          messagingSenderId: "255585079592",
          appId: "1:255585079592:web:5c699c0f4fe6c55304801d",
          measurementId: "G-CZT2XVVY18"
        };
        // Firebase Initialize (var: shared with app.js in separate file)
        var db;
        var auth;
        var googleProvider;
        try {
            firebase.initializeApp(firebaseConfig);
            db = firebase.firestore();
            auth = firebase.auth();
            googleProvider = new firebase.auth.GoogleAuthProvider();
            googleProvider.setCustomParameters({ prompt: 'select_account' });
            console.log('✅ Firebase initialized successfully');
        } catch (error) {
            console.error('❌ Firebase initialization error:', error);
        }

        // ============================================
        // FIRESTORE DATA HELPERS - Convert nested arrays to objects
        // Firestore does NOT support nested arrays, so we convert them
        // These functions must be defined BEFORE they are used
        // ============================================
        
        // Convert nested array table to array of objects for Firestore
        function convertTableForFirestore(table) {
            if (!table || !Array.isArray(table) || table.length === 0) {
                return [];
            }
            
            // Check if it's a nested array (array of arrays)
            if (Array.isArray(table[0])) {
                // Convert: [["col1", "col2"], ["val1", "val2"]] 
                // To: [{col0: "col1", col1: "col2"}, {col0: "val1", col1: "val2"}]
                return table.map((row, rowIndex) => {
                    const rowObj = { _rowIndex: rowIndex };
                    if (Array.isArray(row)) {
                        row.forEach((cell, cellIndex) => {
                            rowObj[`col${cellIndex}`] = cell;
                        });
                    }
                    return rowObj;
                });
            }
            
            // Already an array of objects or simple array
            return table;
        }
        
        // Convert grammatik array for Firestore (handles nested table arrays)
        function convertGrammatikForFirestore(grammatik) {
            if (!grammatik || !Array.isArray(grammatik)) {
                return [];
            }
            
            return grammatik.map(gram => {
                return {
                    topic: gram.topic || '',
                    explanation: gram.explanation || '',
                    example: gram.example || '',
                    // Convert nested array table to array of objects
                    tableData: convertTableForFirestore(gram.table)
                };
            });
        }
        
        // Convert dialogues for Firestore
        function convertDialoguesForFirestore(dialogues) {
            if (!dialogues || !Array.isArray(dialogues)) {
                return [];
            }
            
            return dialogues.map((d, index) => ({
                _index: index,
                speaker: d.speaker || '',
                text: d.text || ''
            }));
        }
        
        // Convert array of objects table back to nested array for rendering
        function convertTableFromFirestore(tableData) {
            if (!tableData || !Array.isArray(tableData) || tableData.length === 0) {
                return [];
            }
            
            // Check if it's already in object format (from Firestore)
            if (tableData[0] && typeof tableData[0] === 'object' && '_rowIndex' in tableData[0]) {
                // Sort by row index
                tableData.sort((a, b) => (a._rowIndex || 0) - (b._rowIndex || 0));
                
                // Convert back to nested array
                return tableData.map(rowObj => {
                    const row = [];
                    let colIndex = 0;
                    while (`col${colIndex}` in rowObj) {
                        row.push(rowObj[`col${colIndex}`]);
                        colIndex++;
                    }
                    return row;
                });
            }
            
            // Already a nested array
            return tableData;
        }
        
        // Convert grammatik from Firestore format back to local format
        function convertGrammatikFromFirestore(grammatik) {
            if (!grammatik || !Array.isArray(grammatik)) {
                return [];
            }
            
            return grammatik.map(gram => ({
                topic: gram.topic || '',
                explanation: gram.explanation || '',
                example: gram.example || '',
                table: convertTableFromFirestore(gram.tableData || gram.table || [])
            }));
        }

