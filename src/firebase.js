// Import Firebase services
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { 
  getAuth, 
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  signInAnonymously
} from 'firebase/auth';

// Your Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDUJoYYqLmX-KQNRK6qkRe7fGRLMi2WYlw",
  authDomain: "task-master-84182.firebaseapp.com",
  projectId: "task-master-84182",
  storageBucket: "task-master-84182.firebasestorage.app",
  messagingSenderId: "108848170914",
  appId: "1:108848170914:web:d89f4159d1c9e90c3694fb"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Email/password authentication helpers
export const registerUser = async (email, password) => {
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    return userCredential;
  } catch (error) {
    console.error("Error registering user:", error);
    throw error;
  }
};

export const loginUser = async (email, password) => {
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential;
  } catch (error) {
    console.error("Error logging in:", error);
    throw error;
  }
};

export const logoutUser = async () => {
  try {
    await signOut(auth);
    return true;
  } catch (error) {
    console.error("Error signing out:", error);
    throw error;
  }
};

// Helper for anonymous authentication
export const signInAnon = async () => {
  try {
    console.log("Firebase: Attempting anonymous sign-in");
    const result = await signInAnonymously(auth);
    console.log("Firebase: Sign-in successful");
    return result;
  } catch (error) {
    console.error("Firebase: Error signing in anonymously:", error);
    console.error("Firebase: Error code:", error.code);
    console.error("Firebase: Error message:", error.message);
    throw error;
  }
};

export { db, auth };