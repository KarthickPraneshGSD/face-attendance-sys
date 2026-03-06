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
const auth = firebase.auth();
