// FaceSync AI — Firebase Configuration
// Using Firebase compat SDK (no bundler required)

const firebaseConfig = {
    apiKey: "AIzaSyAZsOdEh_eZur1Eef90KPi02_fI7_90pTo",
    authDomain: "facerecognize-283b4.firebaseapp.com",
    projectId: "facerecognize-283b4",
    storageBucket: "facerecognize-283b4.firebasestorage.app",
    messagingSenderId: "214846411157",
    appId: "1:214846411157:web:339d2bd08b6d8db2f1669c"
};

firebase.initializeApp(firebaseConfig);

const fsdb = firebase.firestore();

// Enable offline persistence so that if the network drops QUIC connections,
// the app continues to function seamlessly from cache while it auto-reconnects.
fsdb.enablePersistence()
    .catch((err) => {
        if (err.code == 'failed-precondition') {
            console.warn('Multiple tabs open, persistence can only be enabled in one tab at a a time.');
        } else if (err.code == 'unimplemented') {
            console.warn('The current browser does not support all of the features required to enable persistence.');
        }
    });

const auth = firebase.auth();
