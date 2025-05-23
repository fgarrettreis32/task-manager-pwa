import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import { collection, doc, setDoc, updateDoc, deleteDoc, getDocs, onSnapshot, query, orderBy } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth'
import LoginForm from './LoginForm';
import { db, auth, signInAnon, logoutUser } from './firebase';

// Main App Component
function App() {
  const [activeView, setActiveView] = useState('tasks'); // 'tasks' or 'focus'
  const [tasks, setTasks] = useState([]);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  
  // Lifted timer state to the App component level
  const [timerRunning, setTimerRunning] = useState(false);

  const [timerMode, setTimerMode] = useState('work'); // 'work', 'shortBreak', 'longBreak'
  const [sessionsCompleted, setSessionsCompleted] = useState(() => {
    // Load sessions completed from localStorage
    const now = new Date();
    const today = now.toDateString();
    const savedData = localStorage.getItem('sessionData');
    
    if (savedData) {
      const data = JSON.parse(savedData);
      // Only reset if it's a different day
      const savedDate = new Date(data.date);
      const isNewDay = 
        savedDate.getFullYear() !== now.getFullYear() ||
        savedDate.getMonth() !== now.getMonth() ||
        savedDate.getDate() !== now.getDate();
        
      if (!isNewDay) {
        console.log("Continuing with sessions from today:", data.sessionsCompleted);
        return data.sessionsCompleted;
      } else {
        console.log("New day detected, resetting sessions counter");
        return 0;
      }
    }
    return 0;
  });
  const [recurringTimeSpent, setRecurringTimeSpent] = useState(() => {
    // Load recurring time spent from localStorage
    const today = new Date().toDateString();
    const savedData = localStorage.getItem('recurringTimeData');
    if (savedData) {
      const data = JSON.parse(savedData);
      if (data.date === today) {
        return data.timeSpent;
      }
    }
    return 0;
  });
  
  // Timer references to maintain accurate timing
  const timerStartTimeRef = useRef(null);
  const timerEndTimeRef = useRef(null);
  const timerDurations = {
    work: 20 * 60 * 1000,       // 20 minutes in milliseconds
    shortBreak: 5 * 60 * 1000,  // 5 minutes in milliseconds
    longBreak: 10 * 60 * 1000   // 10 minutes in milliseconds
  };
  
  // Timer variables for accurate timing
  const [timerTimeRemaining, setTimerTimeRemaining] = useState(timerDurations.work); // in ms
  
  // Worker for background timer
  const timerWorkerRef = useRef(null);

  // Initialize the worker and handle communication
  useEffect(() => {
    // Create a Blob containing the worker code
    const workerCode = `
      let timerInterval;
      let startTime;
      let pausedTimeRemaining;
      let timerRunning = false;
      
      self.onmessage = function(e) {
        const { action, timeRemaining, timerMode } = e.data;
        
        if (action === 'setTime') {
          timerRunning = false;
          clearInterval(timerInterval);
          pausedTimeRemaining = timeRemaining;
          self.postMessage({ type: 'tick', timeRemaining: timeRemaining });
        }
        else if (action === 'start') {
          startTime = Date.now();
          pausedTimeRemaining = timeRemaining;
          timerRunning = true;
          
          clearInterval(timerInterval);
          timerInterval = setInterval(() => {
            if (timerRunning) {
              const elapsed = Date.now() - startTime;
              const remaining = Math.max(0, pausedTimeRemaining - elapsed);
              self.postMessage({ type: 'tick', timeRemaining: remaining });
              
              if (remaining <= 0) {
                clearInterval(timerInterval);
                timerRunning = false;
                self.postMessage({ type: 'completed', timerMode });
              }
            }
          }, 100); // Update frequently for better accuracy
        } 
        else if (action === 'pause') {
          timerRunning = false;
          clearInterval(timerInterval);
          
          const elapsed = Date.now() - startTime;
          pausedTimeRemaining = Math.max(0, pausedTimeRemaining - elapsed);
          self.postMessage({ type: 'tick', timeRemaining: pausedTimeRemaining });
        }
        else if (action === 'reset') {
          timerRunning = false;
          clearInterval(timerInterval);
          pausedTimeRemaining = timeRemaining;
          self.postMessage({ type: 'tick', timeRemaining: pausedTimeRemaining });
        }
      };
    `;
    
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    
    // Create and setup the worker
    timerWorkerRef.current = new Worker(workerUrl);
    timerWorkerRef.current.onmessage = (e) => {
      const { type, timeRemaining, timerMode: completedTimerMode } = e.data;
      
      if (type === 'tick') {
        setTimerTimeRemaining(timeRemaining);
      }
      else if (type === 'completed') {
        handleTimerCompleted(completedTimerMode);
      }
    };
    
    // Clean up
    return () => {
      if (timerWorkerRef.current) {
        timerWorkerRef.current.terminate();
        URL.revokeObjectURL(workerUrl);
      }
    };
  }, []);
  
  // Handle timer completion
  const handleTimerCompleted = (completedTimerMode) => {
    // Play notification
    playNotification();
    
    setTimerRunning(false);
    
    if (completedTimerMode === 'work') {
      // Increment session counter after work session
      console.log('Work session completed. Current sessions:', sessionsCompleted);
      const newSessionsCompleted = sessionsCompleted + 1;
      console.log('Incrementing to:', newSessionsCompleted);
      
      // Make sure to update state with the new value
      setSessionsCompleted(prevCount => prevCount + 1);
      
      // Every 4 sessions, take a long break
      if (newSessionsCompleted % 4 === 0) {
        setTimerMode('longBreak');
        setTimerTimeRemaining(timerDurations.longBreak);
      } else {
        setTimerMode('shortBreak');
        setTimerTimeRemaining(timerDurations.shortBreak);
      }
      
      // Save to localStorage immediately
      const now = new Date();
      localStorage.setItem('sessionData', JSON.stringify({
        date: now.toISOString(),
        sessionsCompleted: newSessionsCompleted
      }));
      
      console.log('Session data saved to localStorage');
    } else {
      // Break completed, switch to work session
      setTimerMode('work');
      setTimerTimeRemaining(timerDurations.work);
      // Ensure timer is stopped and requires a manual start
      setTimerRunning(false);
    }
  };
  
  // Play a notification sound
  const playNotification = () => {
    try {
      // Play the sound for 5 seconds or until user interaction
      const SOUND_DURATION = 5000; // 5 seconds
      let soundPlaying = true;
      
      // Play the sound on loop for 5 seconds
      const playSound = () => {
        const audio = new Audio("data:audio/wav;base64,//uQRAAAAWMSLwUIYAAsYkXgoQwAEaYLWfkWgAI0wWs/ItAAAGDgYtAgAyN+QWaAAihwMWm4G8QQRDiMcCBcH3Cc+CDv/7xA4Tvh9Rz/y8QADBwMWgQAZG/ILNAARQ4GLTcDeIIIhxGOBAuD7hOfBB3/94gcJ3w+o5/5eIAIAAAVwWgQAVQ2ORaIQwEMAJiDg95G4nQL7mQVWI6GwRcfsZAcsKkJvxgxEjzFUgfHoSQ9Qq7KNwqHwuB13MA4a1q/DmBrHgPcmjiGoh//EwC5nGPEmS4RcfkVKOhJf+WOgoxJclFz3kgn//dBA+ya1GhurNn8zb//9NNutNuhz31f////9vt///z+IdAEAAAK4LQIAKobHItEIYCGAExBwe8jcToF9zIKrEdDYIuP2MgOWFSE34wYiR5iqQPj0JIeoVdlG4VD4XA67mAcNa1fhzA1jwHuTRxDUQ//iYBczjHiTJcIuPyKlHQkv/LHQUYkuSi57yQT//uggfZNajQ3Vmz+Zt//+mm3Wm3Q576v////+32///5/EOgAAADVghQAAAAA//uQZAUAB1WI0PZugAAAAAoQwAAAEk3nRd2qAAAAACiDgAAAAAAABCqEEQRLCgwpBGMlJkIz8jKhGvj4k6jzRnqasNKIeoh5gI7BJaC1A1AoNBjJgbyApVS4IDlZgDU5WUAxEKDNmmALHzZp0Fkz1FMTmGFl1FMEyodIavcCAUHDWrKAIA4aa2oCgILEBupZgHvAhEBcZ6joQBxS76AgccrFlczBvKLC0QI2cBoCFvfTDAo7eoOQInqDPBtvrDEZBNYN5xwNwxQRfw8ZQ5wQVLvO8OYU+mHvFLlDh05Mdg7BT6YrRPpCBznMB2r//xKJjyyOh+cImr2/4doscwD6neZjuZR4AgAABYAAAABy1xcdQtxYBYYZdifkUDgzzXaXn98Z0oi9ILU5mBjFANmRwlVJ3/6jYDAmxaiDG3/6xjQQCCKkRb/6kg/wW+kSJ5//rLobkLSiKmqP/0ikJuDaSaSf/6JiLYLEYnW/+kXg1WRVJL/9EmQ1YZIsv/6Qzwy5qk7/+tEU0nkls3/zIUMPKNX/6yZLf+kFgAfgGyLFAUwY//uQZAUABcd5UiNPVXAAAApAAAAAE0VZQKw9ISAAACgAAAAAVQIygIElVrFkBS+Jhi+EAuu+lKAkYUEIsmEAEoMeDmCETMvfSHTGkF5RWH7kz/ESHWPAq/kcCRhqBtMdokPdM7vil7RG98A2sc7zO6ZvTdM7pmOUAZTnJW+NXxqmd41dqJ6mLTXxrPpnV8avaIf5SvL7pndPvPpndJR9Kuu8fePvuiuhorgWjp7Mf/PRjxcFCPDkW31srioCExivv9lcwKEaHsf/7ow2Fl1T/9RkXgEhYElAoCLFtMArxwivDJJ+bR1HTKJdlEoTELCIqgEwVGSQ+hIm0NbK8WXcTEI0UPoa2NbG4y2K00JEWbZavJXkYaqo9CRHS55FcZTjKEk3NKoCYUnSQ0rWxrZbFKbKIhOKPZe1cJKzZSaQrIyULHDZmV5K4xySsDRKWOruanGtjLJXFEmwaIbDLX0hIPBUQPVFVkQkDoUNfSoDgQGKPekoxeGzA4DUvnn4bxzcZrtJyipKfPNy5w+9lnXwgqsiyHNeSVpemw4bWb9psYeq//uQZBoABQt4yMVxYAIAAAkQoAAAHvYpL5m6AAgAACXDAAAAD59jblTirQe9upFsmZbpMudy7Lz1X1DYsxOOSWpfPqNX2WqktK0DMvuGwlbNj44TleLPQ+Gsfb+GOWOKJoIrWb3cIMeeON6lz2umTqMXV8Mj30yWPpjoSa9ujK8SyeJP5y5mOW1D6hvLepeveEAEDo0mgCRClOEgANv3B9a6fikgUSu/DmAMATrGx7nng5p5iimPNZsfQLYB2sDLIkzRKZOHGAaUyDcpFBSLG9MCQALgAIgQs2YunOszLSAyQYPVC2YdGGeHD2dTdJk1pAHGAWDjnkcLKFymS3RQZTInzySoBwMG0QueC3gMsCEYxUqlrcxK6k1LQQcsmyYeQPdC2YfuGPASCBkcVMQQqpVJshui1tkXQJQV0OXGAZMXSOEEBRirXbVRQW7ugq7IM7rPWSZyDlM3IuNEkxzCOJ0ny2ThNkyRai1b6ev//3dzNGzNb//4uAvHT5sURcZCFcuKLhOFs8mLAAEAt4UWAAIABAAAAAB4qbHo0tIjVkUU//uQZAwABfSFz3ZqQAAAAAngwAAAE1HjMp2qAAAAACZDgAAAD5UkTE1UgZEUExqYynN1qZvqIOREEFmBcJQkwdxiFtw0qEOkGYfRDifBui9MQg4QAHAqWtAWHoCxu1Yf4VfWLPIM2mHDFsbQEVGwyqQoQcwnfHeIkNt9YnkiaS1oizycqJrx4KOQjahZxWbcZgztj2c49nKmkId44S71j0c8eV9yDK6uPRzx5X18eDvjvQ6yKo9ZSS6l//8elePK/Lf//IInrOF/FvDoADYAGBMGb7FtErm5MXMlmPAJQVgWta7Zx2go+8xJ0UiCb8LHHdftWyLJE0QIAIsI+UbXu67dZMjmgDGCGl1H+vpF4NSDckSIkk7Vd+sxEhBQMRU8j/12UIRhzSaUdQ+rQU5kGeFxm+hb1oh6pWWmv3uvmReDl0UnvtapVaIzo1jZbf/pD6ElLqSX+rUmOQNpJFa/r+sa4e/pBlAABoAAAAA3CUgShLdGIxsY7AUABPRrgCABdDuQ5GC7DqPQCgbbJUAoRSUj+NIEig0YfyWUho1VBBBA//uQZB4ABZx5zfMakeAAAAmwAAAAF5F3P0w9GtAAACfAAAAAwLhMDmAYWMgVEG1U0FIGCBgXBXAtfMH10000EEEEEECUBYln03TTTdNBDZopopYvrTTdNa325mImNg3TTPV9q3pmY0xoO6bv3r00y+IDGid/9aaaZTGMuj9mpu9Mpio1dXrr5HERTZSmqU36A3CumzN/9Robv/Xx4v9ijkSRSNLQhAWumap82WRSBUqXStV/YcS+XVLnSS+WLDroqArFkMEsAS+eWmrUzrO0oEmE40RlMZ5+ODIkAyKAGUwZ3mVKmcamcJnMW26MRPgUw6j+LkhyHGVGYjSUUKNpuJUQoOIAyDvEyG8S5yfK6dhZc0Tx1KI/gviKL6qvvFs1+bWtaz58uUNnryq6kt5RzOCkPWlVqVX2a/EEBUdU1KrXLf40GoiiFXK///qpoiDXrOgqDR38JB0bw7SoL+ZB9o1RCkQjQ2CBYZKd/+VJxZRRZlqSkKiws0WFxUyCwsKiMy7hUVFhIaCrNQsKkTIsLivwKKigsj8XYlwt/WKi2N4d//uQRCSAAjURNIHpMZBGYiaQPSYyAAABLAAAAAAAACWAAAAApUF/Mg+0aohSIRobBAsMlO//Kk4soosy1JSFRYWaLC4qZBYWFRGZdwqKiwkNBVmoWFSJkWFxX4FFRQWR+LsS4W/rFRb/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////VEFHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU291bmRib3kuZGUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMjAwNGh0dHA6Ly93d3cuc291bmRib3kuZGUAAAAAAAAAACU=");
        audio.volume = 1.0; // Maximum volume
        
        const playNextBeep = () => {
          if (soundPlaying) {
            audio.play()
              .then(() => {
                // Set up for next beep
                audio.onended = playNextBeep;
              })
              .catch(e => console.error("Error playing audio:", e));
          }
        };
        
        // Start the first beep
        playNextBeep();
        
        // Stop after duration or on user interaction
        setTimeout(() => {
          soundPlaying = false;
        }, SOUND_DURATION);
        
        // Also stop on user interaction
        const stopSoundOnInteraction = () => {
          soundPlaying = false;
          document.removeEventListener('click', stopSoundOnInteraction);
          document.removeEventListener('keydown', stopSoundOnInteraction);
        };
        
        document.addEventListener('click', stopSoundOnInteraction);
        document.addEventListener('keydown', stopSoundOnInteraction);
      };
      
      // Start playing the sound
      playSound();
      
    } catch (error) {
      console.error("Error playing notification:", error);
    }
  };
  
  // Timer controls
  const startTimer = () => {
    if (!timerRunning) {
      setTimerRunning(true);
      timerWorkerRef.current.postMessage({ 
        action: 'start', 
        timeRemaining: timerTimeRemaining, 
        timerMode 
      });
    }
  };
  
  const pauseTimer = () => {
    if (timerRunning) {
      setTimerRunning(false);
      timerWorkerRef.current.postMessage({ action: 'pause' });
    }
  };
  
  const resetTimer = () => {
    const duration = timerDurations[timerMode];
    setTimerTimeRemaining(duration);
    timerWorkerRef.current.postMessage({ 
      action: 'reset', 
      timeRemaining: duration 
    });
  };
  
  const toggleTimer = () => {
    if (timerRunning) {
      pauseTimer();
    } else {
      startTimer();
    }
  };
  
  const changeTimerMode = (newMode) => {
    setTimerMode(newMode);
    const newDuration = timerDurations[newMode];
    setTimerTimeRemaining(newDuration);
    timerWorkerRef.current.postMessage({ 
      action: 'reset', 
      timeRemaining: newDuration 
    });
    // Ensure timer is stopped and requires manual start
    setTimerRunning(false);
  };
  
  const setTimerTime = (newTime) => {
    setTimerTimeRemaining(newTime);
    if (timerWorkerRef.current) {
      timerWorkerRef.current.postMessage({
        action: 'setTime',
        timeRemaining: newTime
      });
    }
  };
  
// Save sessions completed to localStorage whenever it changes
useEffect(() => {
  const now = new Date();
  localStorage.setItem('sessionData', JSON.stringify({
    date: now.toISOString(), // Store full timestamp
    sessionsCompleted
  }));
}, [sessionsCompleted]);

  // Save recurring time spent to localStorage whenever it changes
  useEffect(() => {
    const today = new Date().toDateString();
    localStorage.setItem('recurringTimeData', JSON.stringify({
      date: today,
      timeSpent: recurringTimeSpent
    }));
  }, [recurringTimeSpent]);
  
// Check authentication state on app load
useEffect(() => {
  console.log("Checking authentication state...");
  
  // Set up a listener for auth state changes
  const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
    if (currentUser) {
      console.log("User is signed in:", currentUser.uid);
      setUser(currentUser);
    } else {
      console.log("No user is signed in");
      setUser(null);
    }
    setAuthChecked(true);
    setLoading(false);
  });
  
  // Clean up the listener when component unmounts
  return () => unsubscribe();
}, []);
  
// Load and sync tasks from Firebase when user is authenticated
useEffect(() => {
  if (!user) return;
  
  console.log("Loading tasks for user:", user.uid);
  setLoading(true);
  
  // Create a reference to the user's tasks collection
  const tasksRef = collection(db, 'users', user.uid, 'tasks');
  
  // Set up real-time listener for tasks
  const unsubscribe = onSnapshot(tasksRef, (snapshot) => {
    const loadedTasks = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    console.log("Loaded tasks:", loadedTasks.length);
    setTasks(loadedTasks);
    setLoading(false);
  }, (error) => {
    console.error("Error loading tasks:", error);
    setLoading(false);
  });
  
  // Clean up the listener when component unmounts
  return () => unsubscribe();
}, [user]);

// Check for date change to reset timeSpentToday values
useEffect(() => {
  if (!user) return;

  const now = new Date();
  const today = now.toDateString();
  const lastDateChecked = localStorage.getItem('lastDateChecked');
  
  // If it's a new day, reset all timeSpentToday values
  if (lastDateChecked && lastDateChecked !== today) {
    console.log("New day detected, resetting timeSpentToday for all tasks");
    
    // Update all tasks to reset timeSpentToday
    tasks.forEach(task => {
      try {
        const taskRef = doc(db, 'users', user.uid, 'tasks', task.id);
        updateDoc(taskRef, { timeSpentToday: 0 });
      } catch (error) {
        console.error(`Error resetting timeSpentToday for task ${task.id}:`, error);
      }
    });
    
    // Also update local state
    setTasks(tasks.map(task => ({ ...task, timeSpentToday: 0 })));
  }
  
  // Save today's date for next check
  localStorage.setItem('lastDateChecked', today);
}, [tasks, user]);

// If still checking auth state, show loading
if (!authChecked) {
  return (
    <div className="app-container">
      <div className="loading-screen">
        <h2>Loading Task Master...</h2>
      </div>
    </div>
  );
}

// If not logged in, show login form
if (!user) {
  return (
    <div className="app-container">
      <div className="header">
        <div className="header-content">
          <h1 className="app-title">Task Master</h1>
        </div>
      </div>
      <div className="main-content">
        <LoginForm onLoginSuccess={(user) => setUser(user)} />
      </div>
    </div>
  );
}

// Otherwise show the main app
return (
  <div className="app-container">
    <Header activeView={activeView} setActiveView={setActiveView} user={user} />
    <div className="main-content">
      {activeView === 'tasks' ? (
        <TaskInputView tasks={tasks} setTasks={setTasks} userId={user.uid} />
      ) : (
        <FocusView 
          tasks={tasks} 
          setTasks={setTasks} 
          setActiveView={setActiveView}
          userId={user.uid}
          timerRunning={timerRunning}
          toggleTimer={toggleTimer}
          timerTimeRemaining={timerTimeRemaining}
          timerMode={timerMode}
          resetTimer={resetTimer}
          changeTimerMode={changeTimerMode}
          sessionsCompleted={sessionsCompleted}
          setSessionsCompleted={setSessionsCompleted}
          recurringTimeSpent={recurringTimeSpent}
          setRecurringTimeSpent={setRecurringTimeSpent}
          setTimerTime={setTimerTime}
        />
      )}
    </div>
  </div>
);
}

// Header Component
function Header({ activeView, setActiveView, user }) {
  const handleLogout = async () => {
    try {
      await logoutUser();
      // Auth state listener will handle the state update
    } catch (error) {
      console.error("Logout error:", error);
    }
  };

  return (
    <div className="header">
      <div className="header-content">
        <h1 className="app-title">Task Master</h1>
        <div className="nav-container">
          <div className="nav-buttons">
            <button 
              className={activeView === 'tasks' ? 'active' : ''}
              onClick={() => setActiveView('tasks')}
            >
              Tasks
            </button>
            <button 
              className={activeView === 'focus' ? 'active' : ''}
              onClick={() => setActiveView('focus')}
            >
              Focus
            </button>
          </div>
          
          {user && (
            <div className="user-controls">
              <span className="user-email">{user.email}</span>
              <button onClick={handleLogout} className="logout-button">
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Helper function to format dates consistently
function formatDisplayDate(dateString) {
  if (!dateString) return '';
  
  // For date strings from input elements (YYYY-MM-DD format)
  // Parse without timezone adjustments by manually extracting components
  const parts = dateString.split('-');
  if (parts.length === 3) {
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1; // months are 0-indexed in JS
    const day = parseInt(parts[2]);
    
    // Create date using UTC to avoid timezone shifts
    const date = new Date(Date.UTC(year, month, day));
    return date.toLocaleDateString();
  }
  
  // Fallback for other formats
  return dateString;
}

// Task Input View
function TaskInputView({ tasks, setTasks, userId }) {
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const isAuthenticated = userId !== null;
  const [editingTask, setEditingTask] = useState(null);
  const [isEditingDetails, setIsEditingDetails] = useState(null);
  const [isEditingTitle, setIsEditingTitle] = useState(null);
  const [editedTitle, setEditedTitle] = useState('');
  const [expandedTasks, setExpandedTasks] = useState({});
  const [sortMethod, setSortMethod] = useState('priority');
  const [activeTaskTab, setActiveTaskTab] = useState('inbox');

  const handleAddTask = async () => {
    if (newTaskTitle.trim() === '') return;
    
    console.log("Adding task with title:", newTaskTitle, "userId:", userId);
    
    if (!userId) {
      console.error("No userId available, cannot add task");
      alert("Not signed in yet. Please wait a moment and try again.");
      return;
    }
    
    const taskId = Date.now().toString();
    const taskToAdd = {
      id: taskId,
      title: newTaskTitle.trim(),
      dueDate: '',
      priority: '', // Default to blank
      completed: false,
      timeSpent: 0,
      timeSpentToday: 0, // Add timeSpentToday field
      recurrence: '', // Default to blank
      inEdit: false // Add inEdit field
    };
    
    // We've removed the tab-specific override to ensure tasks always start in inbox
    
    try {
      console.log("Saving task to Firestore:", taskToAdd);
      // Add to Firestore
      const taskRef = doc(db, 'users', userId, 'tasks', taskId);
      await setDoc(taskRef, taskToAdd);
      
      console.log("Task added successfully!");
      // The UI will update automatically through the onSnapshot listener
      setNewTaskTitle('');
      setIsAdding(false);
    } catch (error) {
      console.error("Error adding task:", error);
      alert("Error adding task: " + error.message);
    }
  };

  const deleteTask = async (id) => {
    try {
      // Delete from Firestore
      const taskRef = doc(db, 'users', userId, 'tasks', id);
      await deleteDoc(taskRef);
      
      // UI will update through the onSnapshot listener
    } catch (error) {
      console.error("Error deleting task:", error);
    }
  };

  const updateTaskDetails = async (taskId, updates) => {
    try {
      // Format date correctly if it's being updated
      const formattedUpdates = {...updates};
      
      // If updating a due date, ensure correct format without timezone shift
      if (formattedUpdates.dueDate) {
        // Keep the exact date string from input (YYYY-MM-DD)
        // Don't create a Date object as it will apply timezone shift
        console.log('Saving date: ', formattedUpdates.dueDate);
      }
      
      // Update in Firestore
      const taskRef = doc(db, 'users', userId, 'tasks', taskId);
      await updateDoc(taskRef, formattedUpdates);
      
      // UI will update through the onSnapshot listener
    } catch (error) {
      console.error("Error updating task:", error);
    }
  };

  const toggleTaskCompletion = async (id) => {
    try {
      // Find the current task
      const task = tasks.find(t => t.id === id);
      if (!task) return;
      
      // Update in Firestore
      const taskRef = doc(db, 'users', userId, 'tasks', id);
      await updateDoc(taskRef, { 
        completed: !task.completed 
      });
      
      // UI will update through the onSnapshot listener
    } catch (error) {
      console.error("Error toggling completion:", error);
    }
  };

  const startEditingTitle = (task) => {
    setIsEditingTitle(task.id);
    setEditedTitle(task.title);
  };

  const saveEditedTitle = (taskId) => {
    if (editedTitle.trim() === '') return;
    
    updateTaskDetails(taskId, { title: editedTitle.trim() });
    setIsEditingTitle(null);
    setEditedTitle('');
  };
  
  // Toggle task expansion
  const toggleTaskExpansion = (taskId) => {
    setExpandedTasks(prev => ({
      ...prev,
      [taskId]: !prev[taskId]
    }));
  };

  return (
    <div className="task-input-view">
      <div className="view-header">
        <h2>Your Tasks</h2>
        {!isAuthenticated ? (
          <div className="authenticating">
            <span>Signing in...</span>
          </div>
        ) : (
          <div className="header-actions">
            <div className="sort-dropdown">
              <label htmlFor="sort-select">Sort by:</label>
              <select 
                id="sort-select" 
                value={sortMethod} 
                onChange={(e) => setSortMethod(e.target.value)}
              >
                <option value="priority">Priority</option>
                <option value="dueDate">Due Date</option>
                <option value="recurrence">Recurring Status</option>
              </select>
            </div>
            <button 
              onClick={() => setIsAdding(true)}
              className="add-button"
            >
              Add Task
            </button>
          </div>
        )}
      </div>

      <div className="task-tabs">
        <button
          className={`tab-button ${activeTaskTab === 'inbox' ? 'active' : ''}`}
          onClick={() => setActiveTaskTab('inbox')}
        >
          Inbox
        </button>
        <button
          className={`tab-button ${activeTaskTab === 'recurring' ? 'active' : ''}`}
          onClick={() => setActiveTaskTab('recurring')}
        >
          Recurring Tasks
        </button>
        <button
          className={`tab-button ${activeTaskTab === 'nonrecurring' ? 'active' : ''}`}
          onClick={() => setActiveTaskTab('nonrecurring')}
        >
          Non-recurring Tasks
        </button>
        <button
          className={`tab-button ${activeTaskTab === 'completed' ? 'active' : ''}`}
          onClick={() => setActiveTaskTab('completed')}
        >
          Completed
        </button>
      </div>

      {isAdding && (
        <div className="quick-add-form">
          <input
            type="text"
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            placeholder="Enter task title"
            autoFocus
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                handleAddTask();
              }
            }}
          />
          <div className="quick-add-actions">
            <button onClick={() => setIsAdding(false)} className="cancel-button">
              Cancel
            </button>
            <button onClick={handleAddTask} className="save-button">
              Add Task
            </button>
          </div>
        </div>
      )}

<div className="task-list">
      {tasks.length === 0 ? (
        <div className="empty-state">
          <p>You have no tasks yet. Click "Add Task" to get started.</p>
        </div>
      ) : (
        [...tasks]
        .filter(task => {
          // Keep tasks in inbox if they're being edited
          if (task.inEdit) {
            return activeTaskTab === 'inbox';
          }
          
          if (activeTaskTab === 'inbox') {
            // Show tasks with no priority or due date set, or no recurrence set
            return !task.completed && 
                  (!task.priority || task.priority === '5' || task.priority === '') && 
                  !task.dueDate && 
                  (!task.recurrence || task.recurrence === '');
          } else if (activeTaskTab === 'recurring') {
            // Show non-completed recurring tasks
            return !task.completed && task.recurrence && task.recurrence !== 'non-recurring' && task.recurrence !== '';
          } else if (activeTaskTab === 'nonrecurring') {
            // Show non-completed non-recurring tasks
            return !task.completed && (!task.recurrence || task.recurrence === 'non-recurring') && 
                  ((task.priority && task.priority !== '5') || task.dueDate);
          } else if (activeTaskTab === 'completed') {
            // Show completed tasks
            return task.completed;
          }
          return true;
        })
          .sort((a, b) => {
            if (sortMethod === 'priority') {
              // Sort by priority (1-5, where 1 is highest)
              const priorityA = parseInt(a.priority || '5');
              const priorityB = parseInt(b.priority || '5');
              return priorityA - priorityB;
            } else if (sortMethod === 'dueDate') {
              // Sort by due date (earlier dates first)
              if (!a.dueDate && !b.dueDate) return 0;
              if (!a.dueDate) return 1;
              if (!b.dueDate) return -1;
              return new Date(a.dueDate) - new Date(b.dueDate);
            } else if (sortMethod === 'recurrence') {
              // Sort by recurrence (recurring first, then non-recurring)
              const recurrenceA = a.recurrence && a.recurrence !== 'non-recurring';
              const recurrenceB = b.recurrence && b.recurrence !== 'non-recurring';
              if (recurrenceA && !recurrenceB) return -1;
              if (!recurrenceA && recurrenceB) return 1;
              return 0;
            }
            return 0;
          })
          .map(task => (
            <div key={task.id} className={`task-item ${
              task.completed ? 'completed' : 
              task.priority === '1' ? 'priority-1' :
              task.priority === '2' ? 'priority-2' :
              task.priority === '3' ? 'priority-3' :
              task.priority === '4' ? 'priority-4' :
              task.priority === '5' ? 'priority-5' : ''
            }`}>
              <div className="task-content">
                <div className="task-checkbox">
                  <input 
                    type="checkbox"
                    checked={task.completed}
                    onChange={() => toggleTaskCompletion(task.id)}
                  />
                </div>
                <div className="task-details">
                  <div className="task-header">
                    {isEditingTitle === task.id ? (
                      <div className="edit-title-form">
                        <input
                          type="text"
                          value={editedTitle}
                          onChange={(e) => setEditedTitle(e.target.value)}
                          autoFocus
                          onKeyPress={(e) => {
                            if (e.key === 'Enter') {
                              saveEditedTitle(task.id);
                            }
                          }}
                          onBlur={() => saveEditedTitle(task.id)}
                        />
                      </div>
                    ) : (
                      <div className="task-title-row">
                        <h3 
                          className={task.completed ? 'completed-text' : ''}
                          onClick={() => startEditingTitle(task)}
                        >
                          {task.title}
                        </h3>
                        <button 
                          className={`expand-button ${expandedTasks[task.id] ? 'expanded' : ''}`}
                          onClick={() => toggleTaskExpansion(task.id)}
                          aria-label={expandedTasks[task.id] ? "Collapse task details" : "Expand task details"}
                        >
                          {expandedTasks[task.id] ? '▼' : '►'}
                        </button>
                      </div>
                    )}
                  </div>
                  
                  {/* Only show details if task is expanded or being edited */}
                  {(expandedTasks[task.id] || isEditingDetails === task.id) && (
                    <>
                      {isEditingDetails === task.id ? (
                        <div className="edit-details-form">
                          <div className="form-row">
                          <div className="form-group">
                            <label>Target Completion Date</label>
                            <input
                              type="date"
                              value={task.dueDate || ''}
                              onChange={(e) => {
                                // First update the state directly for immediate UI feedback
                                setTasks(prev => prev.map(t => 
                                  t.id === task.id ? { ...t, dueDate: e.target.value } : t
                                ));
                                // Then update in Firestore
                                updateTaskDetails(task.id, { dueDate: e.target.value });
                              }}
                            />
                          </div>
                            
                            <div className="form-group">
                              <label>Priority</label>
                              <select
                                value={task.priority || ''}
                                onChange={(e) => updateTaskDetails(task.id, { priority: e.target.value })}
                              >
                                <option value="">Select Priority</option>
                                <option value="1">Mission-critical task that directly impacts core responsibilities</option>
                                <option value="2">High-value task with firm deadline</option>
                                <option value="3">Important task that advances key goals</option>
                                <option value="4">Valuable but non-urgent</option>
                                <option value="5">Optional enhancement</option>
                              </select>
                            </div>
                          </div>
                          
                          <div className="form-row">
                            <div className="form-group">
                              <label>Recurrence</label>
                              <select
                                value={task.recurrence || ''}
                                onChange={(e) => updateTaskDetails(task.id, { recurrence: e.target.value })}
                              >
                                <option value="">Select Recurrence</option>
                                <option value="daily">Daily</option>
                                <option value="weekly">Weekly</option>
                                <option value="monthly">Monthly</option>
                                <option value="non-recurring">Non-recurring</option>
                              </select>
                            </div>
                          </div>
                          
                          <button 
                            onClick={() => {
                              // Clear the inEdit flag when Done is clicked
                              updateTaskDetails(task.id, { inEdit: false });
                              setIsEditingDetails(null);
                            }}
                            className="save-button"
                          >
                            Done
                          </button>
                        </div>
                      ) : (
                        <div className="task-meta">
                          {task.dueDate && (
                            <span className="due-date">
                              Target date: {task.dueDate}
                            </span>
                          )}
                          <span className="time-spent">
                            {Math.floor(task.timeSpent / 60)}m spent
                          </span>
                          <span className={`priority-tag priority-${task.priority}`}>
                            Priority: {task.priority}
                          </span>
                          <span className="recurrence-tag">
                            {task.recurrence || 'Non-recurring'}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div className="task-actions">
                  {isEditingDetails !== task.id && isEditingTitle !== task.id && (
                    <>
                      <button 
                        onClick={() => {
                          setIsEditingDetails(task.id);
                          // Set inEdit flag when editing begins
                          updateTaskDetails(task.id, { inEdit: true });
                        }}
                        className="edit-button"
                      >
                        Edit Details
                      </button>
                      <button 
                        onClick={() => deleteTask(task.id)}
                        className="delete-button"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Focus View with Eisenhower Matrix and Pomodoro Timer
function FocusView({ 
  tasks, 
  setTasks, 
  setActiveView,
  userId,
  timerRunning,
  toggleTimer,
  timerTimeRemaining,
  timerMode,
  resetTimer,
  changeTimerMode,
  sessionsCompleted,
  setSessionsCompleted,
  recurringTimeSpent,
  setRecurringTimeSpent,
  setTimerTime
}) {
  const [activeTask, setActiveTask] = useState(null);
  const [taskIndex, setTaskIndex] = useState(0);
  const [sortedTasks, setSortedTasks] = useState([]);
  const [recurringTasks, setRecurringTasks] = useState([]);
  const [recurringTaskIndex, setRecurringTaskIndex] = useState(0);
  const [activeRecurringTask, setActiveRecurringTask] = useState(null);
  const [selectedRecurringTaskId, setSelectedRecurringTaskId] = useState(null);
  const [isEditingSessionCount, setIsEditingSessionCount] = useState(false);
  const [editedSessionCount, setEditedSessionCount] = useState(0);
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  
// Quick Add Task Handler
const handleQuickAddTask = async () => {
  if (newTaskTitle.trim() === '') return;
  
  if (!userId) {
    console.error("No userId available, cannot add task");
    alert("Not signed in yet. Please wait a moment and try again.");
    return;
  }
  
  const taskId = Date.now().toString();
  const taskToAdd = {
    id: taskId,
    title: newTaskTitle.trim(),
    dueDate: '',
    priority: '', // Default to blank
    completed: false,
    timeSpent: 0,
    timeSpentToday: 0,
    recurrence: '', // Default to blank
    inEdit: false
  };
  
  try {
    // Add to Firestore
    const taskRef = doc(db, 'users', userId, 'tasks', taskId);
    await setDoc(taskRef, taskToAdd);
    
    // Reset state
    setNewTaskTitle('');
    setIsAddingTask(false);
  } catch (error) {
    console.error("Error adding task:", error);
    alert("Error adding task: " + error.message);
  }
};

// Priority descriptions for better readability
const priorityDescriptions = {
    '1': 'Mission-critical task that directly impacts core responsibilities',
    '2': 'High-value task with firm deadline',
    '3': 'Important task that advances key goals',
    '4': 'Valuable but non-urgent',
    '5': 'Optional enhancement'
  };

// Function to update task properties
const updateTaskProperty = (taskId, property, value) => {
  console.log(`Updating task ${taskId}, setting ${property} to:`, value);
  
  // First update local state
  setTasks(tasks.map(task => 
    task.id === taskId
      ? { ...task, [property]: value }
      : task
  ));
  
  // Then update in Firebase
  try {
    // For dates, make sure we're storing the exact string value
    if (property === 'dueDate') {
      console.log('Setting due date to: ', value);
    }
    
    const taskRef = doc(db, 'users', userId, 'tasks', taskId);
    updateDoc(taskRef, { [property]: value })
      .then(() => {
        console.log(`Successfully updated task ${taskId} ${property} in Firestore`);
      })
      .catch(error => {
        console.error(`Error updating task ${taskId} in Firestore:`, error);
      });
  } catch (error) {
    console.error("Error updating task:", error);
  }
};
  
  // Calculate max time for slider display
  const maxTimeMs = {
    work: 20 * 60 * 1000,       // 20 minutes
    shortBreak: 5 * 60 * 1000,  // 5 minutes
    longBreak: 10 * 60 * 1000   // 10 minutes
  }[timerMode];
  
  // References for audio notification
  const audioRef = useRef(null);
  const audioContext = useRef(null);
  
  // Reference for task start time tracking
  const taskStartTimeRef = useRef(null);
  
  // Create audio element for notifications
  useEffect(() => {
    // Create an HTML Audio element as a fallback
    if (!audioRef.current) {
      const audio = new Audio();
      audio.src = "data:audio/wav;base64,//uQRAAAAWMSLwUIYAAsYkXgoQwAEaYLWfkWgAI0wWs/ItAAAGDgYtAgAyN+QWaAAihwMWm4G8QQRDiMcCBcH3Cc+CDv/7xA4Tvh9Rz/y8QADBwMWgQAZG/ILNAARQ4GLTcDeIIIhxGOBAuD7hOfBB3/94gcJ3w+o5/5eIAIAAAVwWgQAVQ2ORaIQwEMAJiDg95G4nQL7mQVWI6GwRcfsZAcsKkJvxgxEjzFUgfHoSQ9Qq7KNwqHwuB13MA4a1q/DmBrHgPcmjiGoh//EwC5nGPEmS4RcfkVKOhJf+WOgoxJclFz3kgn//dBA+ya1GhurNn8zb//9NNutNuhz31f////9vt///z+IdAEAAAK4LQIAKobHItEIYCGAExBwe8jcToF9zIKrEdDYIuP2MgOWFSE34wYiR5iqQPj0JIeoVdlG4VD4XA67mAcNa1fhzA1jwHuTRxDUQ//iYBczjHiTJcIuPyKlHQkv/LHQUYkuSi57yQT//uggfZNajQ3Vmz+Zt//+mm3Wm3Q576v////+32///5/EOgAAADVghQAAAAA//uQZAUAB1WI0PZugAAAAAoQwAAAEk3nRd2qAAAAACiDgAAAAAAABCqEEQRLCgwpBGMlJkIz8jKhGvj4k6jzRnqasNKIeoh5gI7BJaC1A1AoNBjJgbyApVS4IDlZgDU5WUAxEKDNmmALHzZp0Fkz1FMTmGFl1FMEyodIavcCAUHDWrKAIA4aa2oCgILEBupZgHvAhEBcZ6joQBxS76AgccrFlczBvKLC0QI2cBoCFvfTDAo7eoOQInqDPBtvrDEZBNYN5xwNwxQRfw8ZQ5wQVLvO8OYU+mHvFLlDh05Mdg7BT6YrRPpCBznMB2r//xKJjyyOh+cImr2/4doscwD6neZjuZR4AgAABYAAAABy1xcdQtxYBYYZdifkUDgzzXaXn98Z0oi9ILU5mBjFANmRwlVJ3/6jYDAmxaiDG3/6xjQQCCKkRb/6kg/wW+kSJ5//rLobkLSiKmqP/0ikJuDaSaSf/6JiLYLEYnW/+kXg1WRVJL/9EmQ1YZIsv/6Qzwy5qk7/+tEU0nkls3/zIUMPKNX/6yZLf+kFgAfgGyLFAUwY//uQZAUABcd5UiNPVXAAAApAAAAAE0VZQKw9ISAAACgAAAAAVQIygIElVrFkBS+Jhi+EAuu+lKAkYUEIsmEAEoMeDmCETMvfSHTGkF5RWH7kz/ESHWPAq/kcCRhqBtMdokPdM7vil7RG98A2sc7zO6ZvTdM7pmOUAZTnJW+NXxqmd41dqJ6mLTXxrPpnV8avaIf5SvL7pndPvPpndJR9Kuu8fePvuiuhorgWjp7Mf/PRjxcFCPDkW31srioCExivv9lcwKEaHsf/7ow2Fl1T/9RkXgEhYElAoCLFtMArxwivDJJ+bR1HTKJdlEoTELCIqgEwVGSQ+hIm0NbK8WXcTEI0UPoa2NbG4y2K00JEWbZavJXkYaqo9CRHS55FcZTjKEk3NKoCYUnSQ0rWxrZbFKbKIhOKPZe1cJKzZSaQrIyULHDZmV5K4xySsDRKWOruanGtjLJXFEmwaIbDLX0hIPBUQPVFVkQkDoUNfSoDgQGKPekoxeGzA4DUvnn4bxzcZrtJyipKfPNy5w+9lnXwgqsiyHNeSVpemw4bWb9psYeq//uQZBoABQt4yMVxYAIAAAkQoAAAHvYpL5m6AAgAACXDAAAAD59jblTirQe9upFsmZbpMudy7Lz1X1DYsxOOSWpfPqNX2WqktK0DMvuGwlbNj44TleLPQ+Gsfb+GOWOKJoIrWb3cIMeeON6lz2umTqMXV8Mj30yWPpjoSa9ujK8SyeJP5y5mOW1D6hvLepeveEAEDo0mgCRClOEgANv3B9a6fikgUSu/DmAMATrGx7nng5p5iimPNZsfQLYB2sDLIkzRKZOHGAaUyDcpFBSLG9MCQALgAIgQs2YunOszLSAyQYPVC2YdGGeHD2dTdJk1pAHGAWDjnkcLKFymS3RQZTInzySoBwMG0QueC3gMsCEYxUqlrcxK6k1LQQcsmyYeQPdC2YfuGPASCBkcVMQQqpVJshui1tkXQJQV0OXGAZMXSOEEBRirXbVRQW7ugq7IM7rPWSZyDlM3IuNEkxzCOJ0ny2ThNkyRai1b6ev//3dzNGzNb//4uAvHT5sURcZCFcuKLhOFs8mLAAEAt4UWAAIABAAAAAB4qbHo0tIjVkUU//uQZAwABfSFz3ZqQAAAAAngwAAAE1HjMp2qAAAAACZDgAAAD5UkTE1UgZEUExqYynN1qZvqIOREEFmBcJQkwdxiFtw0qEOkGYfRDifBui9MQg4QAHAqWtAWHoCxu1Yf4VfWLPIM2mHDFsbQEVGwyqQoQcwnfHeIkNt9YnkiaS1oizycqJrx4KOQjahZxWbcZgztj2c49nKmkId44S71j0c8eV9yDK6uPRzx5X18eDvjvQ6yKo9ZSS6l//8elePK/Lf//IInrOF/FvDoADYAGBMGb7FtErm5MXMlmPAJQVgWta7Zx2go+8xJ0UiCb8LHHdftWyLJE0QIAIsI+UbXu67dZMjmgDGCGl1H+vpF4NSDckSIkk7Vd+sxEhBQMRU8j/12UIRhzSaUdQ+rQU5kGeFxm+hb1oh6pWWmv3uvmReDl0UnvtapVaIzo1jZbf/pD6ElLqSX+rUmOQNpJFa/r+sa4e/pBlAABoAAAAA3CUgShLdGIxsY7AUABPRrgCABdDuQ5GC7DqPQCgbbJUAoRSUj+NIEig0YfyWUho1VBBBA//uQZB4ABZx5zfMakeAAAAmwAAAAF5F3P0w9GtAAACfAAAAAwLhMDmAYWMgVEG1U0FIGCBgXBXAtfMH10000EEEEEECUBYln03TTTdNBDZopopYvrTTdNa325mImNg3TTPV9q3pmY0xoO6bv3r00y+IDGid/9aaaZTGMuj9mpu9Mpio1dXrr5HERTZSmqU36A3CumzN/9Robv/Xx4v9ijkSRSNLQhAWumap82WRSBUqXStV/YcS+XVLnSS+WLDroqArFkMEsAS+eWmrUzrO0oEmE40RlMZ5+ODIkAyKAGUwZ3mVKmcamcJnMW26MRPgUw6j+LkhyHGVGYjSUUKNpuJUQoOIAyDvEyG8S5yfK6dhZc0Tx1KI/gviKL6qvvFs1+bWtaz58uUNnryq6kt5RzOCkPWlVqVX2a/EEBUdU1KrXLf40GoiiFXK///qpoiDXrOgqDR38JB0bw7SoL+ZB9o1RCkQjQ2CBYZKd/+VJxZRRZlqSkKiws0WFxUyCwsKiMy7hUVFhIaCrNQsKkTIsLivwKKigsj8XYlwt/WKi2N4d//uQRCSAAjURNIHpMZBGYiaQPSYyAAABLAAAAAAAACWAAAAApUF/Mg+0aohSIRobBAsMlO//Kk4soosy1JSFRYWaLC4qZBYWFRGZdwqKiwkNBVmoWFSJkWFxX4FFRQWR+LsS4W/rFRb/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////VEFHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU291bmRib3kuZGUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMjAwNGh0dHA6Ly93d3cuc291bmRib3kuZGUAAAAAAAAAACU=";
      audio.preload = "auto";
      audio.volume = 1.0; // Louder notification
      audioRef.current = audio;
    }

    // Initialize Web Audio API for custom sound
    if (!audioContext.current) {
      try {
        audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
      } catch (error) {
        console.error("Failed to create AudioContext:", error);
      }
    }
    
    // Request audio permission early
    const enableAudio = () => {
      if (audioContext.current && audioContext.current.state === 'suspended') {
        audioContext.current.resume();
      }
      // Play a silent sound to enable audio
      const silentSound = audioRef.current.cloneNode();
      silentSound.volume = 0.01;
      silentSound.play().catch(e => console.error("Error playing silent sound:", e));
      
      // Remove event listeners once audio is enabled
      document.removeEventListener('click', enableAudio);
      document.removeEventListener('keydown', enableAudio);
    };
    
    document.addEventListener('click', enableAudio);
    document.addEventListener('keydown', enableAudio);
    
    // Cleanup when component unmounts
    return () => {
      document.removeEventListener('click', enableAudio);
      document.removeEventListener('keydown', enableAudio);
      if (audioContext.current && audioContext.current.state !== 'closed') {
        audioContext.current.close();
      }
    };
  }, []);

// Update task time spent when work timer completes
useEffect(() => {
  // Only update if the timer is running in work mode and we have an active task
  if (timerRunning && timerMode === 'work') {
    // Initialize task start time when timer starts running
    if (!taskStartTimeRef.current) {
      taskStartTimeRef.current = Date.now();
    }
    
    // Set up an interval to update the time spent more frequently
    const timeUpdateInterval = setInterval(() => {
      const timeSpentSinceStart = Math.floor((Date.now() - taskStartTimeRef.current) / 1000);
      
      if (timeSpentSinceStart > 0) {
        if (activeTask) {
          // Get the current task from the tasks array to ensure we have the most up-to-date timeSpent
          const currentTask = tasks.find(task => task.id === activeTask.id);
          const updatedTimeSpent = (currentTask?.timeSpent || 0) + timeSpentSinceStart;
          
          // Update local state first for immediate UI reflection
          setTasks(prev => prev.map(task => 
            task.id === activeTask.id 
              ? { ...task, timeSpent: updatedTimeSpent } 
              : task
          ));
          
          // Also update in Firebase
          const taskRef = doc(db, 'users', userId, 'tasks', activeTask.id);
          updateDoc(taskRef, { 
            timeSpent: updatedTimeSpent 
          }).catch(error => {
            console.error("Error updating non-recurring task time:", error);
          });
        } else if (selectedRecurringTaskId) {
          // Get the selected recurring task from the tasks array
          const selectedRecurringTask = tasks.find(task => task.id === selectedRecurringTaskId);
          if (selectedRecurringTask) {
            const updatedTimeSpent = (selectedRecurringTask?.timeSpent || 0) + timeSpentSinceStart;
            
            // Update local state first for immediate UI reflection
            setTasks(prev => prev.map(task => 
              task.id === selectedRecurringTaskId 
                ? { ...task, timeSpent: updatedTimeSpent } 
                : task
            ));
            
            // Also update in Firebase
            const taskRef = doc(db, 'users', userId, 'tasks', selectedRecurringTaskId);
            updateDoc(taskRef, { 
              timeSpent: updatedTimeSpent
            }).catch(error => {
              console.error("Error updating recurring task time:", error);
            });
            
            setRecurringTimeSpent(prev => prev + timeSpentSinceStart);
          }
        }
        
        // Reset the start time reference for the next update
        taskStartTimeRef.current = Date.now();
      }
    }, 15000); // Update every 15 seconds for more responsive feedback
      
    const handleBeforeUnload = () => {
      // Calculate time spent and update the task
      const timeSpentInSeconds = Math.floor((Date.now() - taskStartTimeRef.current) / 1000);
      
      if (timeSpentInSeconds > 0) {
        if (activeTask) {
                  // Get the current task to ensure we have the most up-to-date timeSpent
                  const currentTask = tasks.find(task => task.id === activeTask.id);
                  const updatedTimeSpent = (currentTask?.timeSpent || 0) + timeSpentInSeconds;
                  
                  // Update local state
                  setTasks(tasks.map(task => 
                    task.id === activeTask.id 
                      ? { ...task, timeSpent: updatedTimeSpent } 
                      : task
                  ));
                  
                  // Try to update Firebase
                  try {
                    const taskRef = doc(db, 'users', userId, 'tasks', activeTask.id);
                    updateDoc(taskRef, { timeSpent: updatedTimeSpent });
                  } catch (error) {
                    console.error("Error saving task time on page close:", error);
                  }
                } else if (selectedRecurringTaskId) {
          // Get the selected recurring task
          const selectedRecurringTask = tasks.find(task => task.id === selectedRecurringTaskId);
          if (selectedRecurringTask) {
            const updatedTimeSpent = (selectedRecurringTask?.timeSpent || 0) + timeSpentInSeconds;
            
            // Update local state
            setTasks(tasks.map(task => 
              task.id === selectedRecurringTaskId 
                ? { ...task, timeSpent: updatedTimeSpent } 
                : task
            ));
            
            // Try to update Firebase
            try {
              const taskRef = doc(db, 'users', userId, 'tasks', selectedRecurringTaskId);
              updateDoc(taskRef, { timeSpent: updatedTimeSpent });
            } catch (error) {
              console.error("Error saving recurring task time on page close:", error);
            }
            
            setRecurringTimeSpent(prev => prev + timeSpentInSeconds);
          }
        }
      }
    };
      
      window.addEventListener('beforeunload', handleBeforeUnload);
      
      return () => {
        window.removeEventListener('beforeunload', handleBeforeUnload);
        clearInterval(timeUpdateInterval);
      };
    } else {
      // Reset task start time when timer is not running
      taskStartTimeRef.current = null;
    }
  }, [timerRunning, timerMode, activeTask, selectedRecurringTaskId, tasks, setTasks, setRecurringTimeSpent, userId]);

  // Sort tasks based on priority and due date
  useEffect(() => {
    // Make sure we only include actual incomplete tasks 
    // that have priority or due date set (not in inbox)
    const incompleteTasks = tasks.filter(task => 
      !task.completed && 
      (!task.recurrence || task.recurrence === 'non-recurring') &&
      ((task.priority && task.priority !== '5') || task.dueDate)
    );
    
    // Sort using Eisenhower Matrix approach (importance vs urgency)
    const sorted = [...incompleteTasks].sort((a, b) => {
      const now = new Date();
      const oneWeekFromNow = new Date();
      oneWeekFromNow.setDate(now.getDate() + 7);
      
      // Calculate importance from priority (1-2 = high, 3-5 = lower)
      const isHighImportanceA = parseInt(a.priority || '5') <= 2;
      const isHighImportanceB = parseInt(b.priority || '5') <= 2;
      
      // Calculate urgency from due date (due within 7 days = urgent)
      const dueDateA = a.dueDate ? new Date(a.dueDate) : null;
      const dueDateB = b.dueDate ? new Date(b.dueDate) : null;
      
      const isUrgentA = dueDateA ? dueDateA <= oneWeekFromNow : false;
      const isUrgentB = dueDateB ? dueDateB <= oneWeekFromNow : false;
      
      // Determine Eisenhower quadrant (1-4)
      // Q1: Important & Urgent (do first)
      // Q2: Important & Not Urgent (schedule)
      // Q3: Not Important & Urgent (delegate/do soon)
      // Q4: Not Important & Not Urgent (do later/eliminate)
      
      const getQuadrant = (isHighImportance, isUrgent) => {
        if (isHighImportance && isUrgent) return 1;
        if (isHighImportance && !isUrgent) return 2;
        if (!isHighImportance && isUrgent) return 3;
        return 4;
      };
      
      const quadrantA = getQuadrant(isHighImportanceA, isUrgentA);
      const quadrantB = getQuadrant(isHighImportanceB, isUrgentB);
      
      // First sort by quadrant
      if (quadrantA !== quadrantB) {
        return quadrantA - quadrantB;
      }
      
      // Within the same quadrant, sort by due date first (if available)
      if (dueDateA && dueDateB) {
        // If both due dates are the same, proceed to other criteria
        const dateA = dueDateA.toDateString();
        const dateB = dueDateB.toDateString();
        if (dateA !== dateB) {
          return dueDateA - dueDateB;
        }
      } else if (dueDateA) {
        return -1;
      } else if (dueDateB) {
        return 1;
      }

      // If dates are equal or not applicable, sort by exact priority number
      const priorityA = parseInt(a.priority || '5');
      const priorityB = parseInt(b.priority || '5');
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      
      // If priority is equal, consider tasks with less time spent as higher priority
      // This helps balance workload across similar priority tasks
      const timeSpentA = a.timeSpent || 0;
      const timeSpentB = b.timeSpent || 0;
      
      // If one task has spent >= 60 min and the other has spent < 60 min, 
      // prioritize the one with less time
      if (timeSpentA >= 3600 && timeSpentB < 3600) {
        return 1; // B comes first
      }
      if (timeSpentB >= 3600 && timeSpentA < 3600) {
        return -1; // A comes first
      }
      
      // Otherwise, default sort with no particular preference
      return 0;
    });

    setSortedTasks(sorted);
    
    // If the current active task is completed, select a new task
    if (activeTask && tasks.find(t => t.id === activeTask.id)?.completed) {
      if (sorted.length > 0) {
        setActiveTask(sorted[0]);
        setTaskIndex(0);
      } else {
        setActiveTask(null);
        setTaskIndex(0);
      }
    }
    // Otherwise update as normal
    else if (sorted.length > 0 && !activeTask) {
      setActiveTask(sorted[0]);
      setTaskIndex(0);
    } else if (sorted.length > 0) {
      const currentTaskIndex = sorted.findIndex(task => task.id === activeTask?.id);
      if (currentTaskIndex === -1) {
        setActiveTask(sorted[0]);
        setTaskIndex(0);
      } else {
        setTaskIndex(currentTaskIndex);
      }
    } else {
      setActiveTask(null);
      setTaskIndex(0);
    }
      
    // Handle recurring tasks
    const recTasks = tasks.filter(task => 
      !task.completed && 
      task.recurrence && 
      task.recurrence !== 'non-recurring'
    );

    // Sort recurring tasks by priority: daily > weekly > monthly, then by task priority
    const sortedRecurring = [...recTasks].sort((a, b) => {
      // First by recurrence pattern
      const recurrenceOrder = { 'daily': 1, 'weekly': 2, 'monthly': 3 };
      const orderA = recurrenceOrder[a.recurrence] || 4;
      const orderB = recurrenceOrder[b.recurrence] || 4;
      
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      
      // Then by priority (lower number = higher priority)
      const priorityA = parseInt(a.priority || '5');
      const priorityB = parseInt(b.priority || '5');
      
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      
      // Then by due date if available
      if (a.dueDate && b.dueDate) {
        return new Date(a.dueDate) - new Date(b.dueDate);
      }
      
      return 0;
    });

    setRecurringTasks(sortedRecurring);

    // Clear selected recurring task if it's completed
    if (selectedRecurringTaskId && tasks.find(t => t.id === selectedRecurringTaskId)?.completed) {
      setSelectedRecurringTaskId(null);
    }
    }, [tasks, activeTask, selectedRecurringTaskId]);

  // Handle slider change - reversed direction (max to 0)
  const handleSliderChange = (e) => {
    const sliderValue = parseInt(e.target.value);
    // Convert the reversed slider value to the actual time value in ms
    const actualValue = maxTimeMs - sliderValue;
    // Use the passed-down function to set the timer
    setTimerTime(actualValue);
  };

  // Reset sessions counter
  const resetSessions = () => {
    setSessionsCompleted(0);
  };
  
  // Toggle session count edit mode
  const toggleEditSessionCount = () => {
    if (isEditingSessionCount) {
      // If we're already editing, save the changes
      if (editedSessionCount >= 0) {
        setSessionsCompleted(Number(editedSessionCount));
      }
      setIsEditingSessionCount(false);
    } else {
      // If we're not editing, start editing and initialize with current value
      setEditedSessionCount(sessionsCompleted);
      setIsEditingSessionCount(true);
    }
  };
  
// Update time spent on current task
const updateCurrentTaskTime = () => {
  // Only update if timer is running in work mode and we have a start time
  if (timerRunning && timerMode === 'work' && taskStartTimeRef.current) {
    const timeSpentMs = Date.now() - taskStartTimeRef.current;
    const timeSpentSeconds = Math.floor(timeSpentMs / 1000);
    
    if (timeSpentSeconds > 0) {
      if (activeTask) {
        // Get the current task
        const currentTask = tasks.find(task => task.id === activeTask.id);
        const updatedTimeSpent = (currentTask?.timeSpent || 0) + timeSpentSeconds;
        const updatedTimeSpentToday = (currentTask?.timeSpentToday || 0) + timeSpentSeconds;
        
        // Update non-recurring task in local state
        setTasks(tasks.map(task => 
          task.id === activeTask.id 
            ? { ...task, timeSpent: updatedTimeSpent, timeSpentToday: updatedTimeSpentToday } 
            : task
        ));
        
        // Update in Firebase
        try {
          const taskRef = doc(db, 'users', userId, 'tasks', activeTask.id);
          updateDoc(taskRef, { 
            timeSpent: updatedTimeSpent,
            timeSpentToday: updatedTimeSpentToday
          });
        } catch (error) {
          console.error("Error updating non-recurring task time:", error);
        }
      } else if (selectedRecurringTaskId) {
        // Get the selected recurring task
        const selectedRecurringTask = tasks.find(task => task.id === selectedRecurringTaskId);
        if (selectedRecurringTask) {
          const updatedTimeSpent = (selectedRecurringTask?.timeSpent || 0) + timeSpentSeconds;
          const updatedTimeSpentToday = (selectedRecurringTask?.timeSpentToday || 0) + timeSpentSeconds;
          
          // Update recurring task in local state
          setTasks(tasks.map(task => 
            task.id === selectedRecurringTaskId 
              ? { ...task, timeSpent: updatedTimeSpent, timeSpentToday: updatedTimeSpentToday } 
              : task
          ));
          
          // Update in Firebase
          try {
            const taskRef = doc(db, 'users', userId, 'tasks', selectedRecurringTaskId);
            updateDoc(taskRef, { 
              timeSpent: updatedTimeSpent,
              timeSpentToday: updatedTimeSpentToday
            });
          } catch (error) {
            console.error("Error updating recurring task time:", error);
          }
          
          // Also update total recurring time spent today
          setRecurringTimeSpent(prev => prev + timeSpentSeconds);
        }
      }
    }
    
    // Reset the start time for the next task
    taskStartTimeRef.current = Date.now();
  }
};
  
  // Handle session count input change
  const handleSessionCountChange = (e) => {
    const value = e.target.value;
    // Ensure only non-negative numbers are entered
    if (value === '' || (/^\d+$/.test(value) && parseInt(value) >= 0)) {
      setEditedSessionCount(value);
    }
  };

  // Navigate to next task for non-recurring tasks
  const goToNextTask = () => {
    if (sortedTasks.length === 0) return;
    
    // Update time spent on current task before switching
    updateCurrentTaskTime();
    
    const newIndex = (taskIndex + 1) % sortedTasks.length;
    setTaskIndex(newIndex);
    setActiveTask(sortedTasks[newIndex]);
  };

  // Navigate to previous task for non-recurring tasks
  const goToPreviousTask = () => {
    if (sortedTasks.length === 0) return;
    
    // Update time spent on current task before switching
    updateCurrentTaskTime();
    
    const newIndex = (taskIndex - 1 + sortedTasks.length) % sortedTasks.length;
    setTaskIndex(newIndex);
    setActiveTask(sortedTasks[newIndex]);
  };
  
  // Navigate to next recurring task
  const goToNextRecurringTask = () => {
    if (recurringTasks.length === 0) return;
    
    // Update time spent on current task before switching
    updateCurrentTaskTime();
    
    const newIndex = (recurringTaskIndex + 1) % recurringTasks.length;
    setRecurringTaskIndex(newIndex);
    setActiveRecurringTask(recurringTasks[newIndex]);
  };

  // Navigate to previous recurring task
  const goToPreviousRecurringTask = () => {
    if (recurringTasks.length === 0) return;
    
    // Update time spent on current task before switching
    updateCurrentTaskTime();
    
    const newIndex = (recurringTaskIndex - 1 + recurringTasks.length) % recurringTasks.length;
    setRecurringTaskIndex(newIndex);
    setActiveRecurringTask(recurringTasks[newIndex]);
  };

  // Skip break
  const skipBreak = () => {
    changeTimerMode('work');
    // Timer mode change already sets timerRunning to false
  };

  // Format time as mm:ss
  const formatTime = (milliseconds) => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Mark task as complete
    const completeTask = () => {
      // Update time spent on current task before marking as complete
      updateCurrentTaskTime();
      
      if (activeTask) {
          // Update local state
        setTasks(tasks.map(task => 
          task.id === activeTask.id ? { ...task, completed: true } : task
        ));
        
        // Also update in Firebase
        try {
          const taskRef = doc(db, 'users', userId, 'tasks', activeTask.id);
          updateDoc(taskRef, { completed: true });
        } catch (error) {
          console.error("Error marking task as complete:", error);
        }
        
        goToNextTask();
      }
    };

  // Format recurring time spent
  const formatRecurringTime = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  };

  // Test sound button (for debugging)
  const testSound = () => {
    // Trigger the playNotification function in the parent component
    const audio = new Audio("data:audio/wav;base64,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qJrx4KOQjahZxWbcZgztj2c49nKmkId44S71j0c8eV9yDK6uPRzx5X18eDvjvQ6yKo9ZSS6l//8elePK/Lf//IInrOF/FvDoADYAGBMGb7FtErm5MXMlmPAJQVgWta7Zx2go+8xJ0UiCb8LHHdftWyLJE0QIAIsI+UbXu67dZMjmgDGCGl1H+vpF4NSDckSIkk7Vd+sxEhBQMRU8j/12UIRhzSaUdQ+rQU5kGeFxm+hb1oh6pWWmv3uvmReDl0UnvtapVaIzo1jZbf/pD6ElLqSX+rUmOQNpJFa/r+sa4e/pBlAABoAAAAA3CUgShLdGIxsY7AUABPRrgCABdDuQ5GC7DqPQCgbbJUAoRSUj+NIEig0YfyWUho1VBBBA//uQZB4ABZx5zfMakeAAAAmwAAAAF5F3P0w9GtAAACfAAAAAwLhMDmAYWMgVEG1U0FIGCBgXBXAtfMH10000EEEEEECUBYln03TTTdNBDZopopYvrTTdNa325mImNg3TTPV9q3pmY0xoO6bv3r00y+IDGid/9aaaZTGMuj9mpu9Mpio1dXrr5HERTZSmqU36A3CumzN/9Robv/Xx4v9ijkSRSNLQhAWumap82WRSBUqXStV/YcS+XVLnSS+WLDroqArFkMEsAS+eWmrUzrO0oEmE40RlMZ5+ODIkAyKAGUwZ3mVKmcamcJnMW26MRPgUw6j+LkhyHGVGYjSUUKNpuJUQoOIAyDvEyG8S5yfK6dhZc0Tx1KI/gviKL6qvvFs1+bWtaz58uUNnryq6kt5RzOCkPWlVqVX2a/EEBUdU1KrXLf40GoiiFXK///qpoiDXrOgqDR38JB0bw7SoL+ZB9o1RCkQjQ2CBYZKd/+VJxZRRZlqSkKiws0WFxUyCwsKiMy7hUVFhIaCrNQsKkTIsLivwKKigsj8XYlwt/WKi2N4d//uQRCSAAjURNIHpMZBGYiaQPSYyAAABLAAAAAAAACWAAAAApUF/Mg+0aohSIRobBAsMlO//Kk4soosy1JSFRYWaLC4qZBYWFRGZdwqKiwkNBVmoWFSJkWFxX4FFRQWR+LsS4W/rFRb/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////VEFHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU291bmRib3kuZGUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMjAwNGh0dHA6Ly93d3cuc291bmRib3kuZGUAAAAAAAAAACU=");
    audio.volume = 1.0;
    audio.play().catch(e => console.error("Error playing test sound:", e));
  };

  return (
    <div className="focus-view">
      <div className="pomodoro-container">
        {/* Quick Add Task Button */}
        <div className="quick-add-task">
          <button 
            onClick={() => setIsAddingTask(true)}
            className="add-task-button"
          >
            Add Task
          </button>
        </div>
        
        {/* Quick Add Task Form */}
        {isAddingTask && (
          <div className="quick-add-form">
            <input
              type="text"
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              placeholder="Enter task title"
              autoFocus
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleQuickAddTask();
                }
              }}
            />
            <div className="quick-add-actions">
              <button onClick={() => setIsAddingTask(false)} className="cancel-button">
                Cancel
              </button>
              <button onClick={handleQuickAddTask} className="save-button">
                Add Task
              </button>
            </div>
          </div>
        )}
        
        {/* Session Counter */}
        <div className="session-counter">
          <div className="counter-card">
            <div className="counter-header">
              <h3 className="counter-title">Sessions Today</h3>
              <div className="counter-actions">
                <button 
                  className="edit-sessions-button" 
                  onClick={toggleEditSessionCount}
                  title={isEditingSessionCount ? "Save session count" : "Edit session count"}
                >
                  {isEditingSessionCount ? "Save" : "Edit"}
                </button>
                <button 
                  className="reset-sessions-button" 
                  onClick={resetSessions}
                  title="Reset sessions counter"
                >
                  Reset
                </button>
              </div>
            </div>
            {isEditingSessionCount ? (
              <div className="edit-counter-value">
                <input
                  type="number"
                  min="0"
                  value={editedSessionCount}
                  onChange={handleSessionCountChange}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      toggleEditSessionCount();
                    }
                  }}
                  autoFocus
                />
              </div>
            ) : (
              <div className="counter-value">{sessionsCompleted}</div>
            )}
          </div>
        </div>
        
        {/* Pomodoro Timer */}
        <div className={`timer-section ${timerMode}`}>
          <h2 className="timer-label">
            {timerMode === 'work' ? 'Work Session' : 
             timerMode === 'shortBreak' ? 'Short Break' : 'Long Break'}
          </h2>
          <div className="timer-display">
            {formatTime(timerTimeRemaining)}
          </div>
          
          {/* Timer slider - reversed direction */}
          <div className="timer-slider-container">
            <input
              type="range"
              min="0"
              max={maxTimeMs}
              value={maxTimeMs - timerTimeRemaining} // Reverse the value
              onChange={handleSliderChange}
              className="timer-slider"
              disabled={timerRunning}
            />
            <div className="slider-labels">
              <span>{formatTime(maxTimeMs)}</span>
              <span>{formatTime(Math.floor(maxTimeMs / 2))}</span>
              <span>0:00</span>
            </div>
          </div>
          
          <div className="timer-controls">
            <button 
              onClick={toggleTimer}
              className={`timer-button ${timerRunning ? 'pause' : 'play'}`}
            >
              {timerRunning ? 'Pause' : 'Start'}
            </button>
            <button 
              onClick={resetTimer}
              className="timer-button reset"
            >
              Reset
            </button>
            {timerMode !== 'work' && (
              <button 
                onClick={skipBreak}
                className="timer-button skip"
              >
                Skip
              </button>
            )}
            {/* Test sound button (for debugging) */}
            <button 
              onClick={testSound}
              className="timer-button test-sound"
              title="Test notification sound"
            >
              🔊
            </button>
          </div>
          <div className="session-info">
            Session {Math.floor(sessionsCompleted / 4) + 1}.{sessionsCompleted % 4 + 1}
          </div>
        </div>
        
  {/* Recurring Tasks Sidebar */}
  <div className="recurring-tasks-sidebar">
    <h3 className="sidebar-title">Recurring Tasks</h3>
    {recurringTasks.length > 0 ? (
      <div className="recurring-tasks-list">
        <div className="no-selection-option">
          <button 
            className={`recurring-task-button ${selectedRecurringTaskId === null ? 'selected' : ''}`}
            onClick={() => setSelectedRecurringTaskId(null)}
          >
            <span className="task-bullet">○</span>
            <span className="task-name">No recurring task selected</span>
          </button>
        </div>
        {recurringTasks.map(task => (
          <div key={task.id} className="recurring-task-item">
            <button 
              className={`recurring-task-button ${selectedRecurringTaskId === task.id ? 'selected' : ''}`}
              onClick={() => setSelectedRecurringTaskId(task.id)}
            >
              <span className="task-bullet">{selectedRecurringTaskId === task.id ? '●' : '○'}</span>
              <span className="task-name">{task.title}</span>
            </button>
            <div className="task-time-info">
              <span className="time-spent">{Math.floor(task.timeSpent / 60)}m total</span>
              <span className="time-spent-today">{Math.floor((task.timeSpentToday || 0) / 60)}m today</span>
            </div>
          </div>
        ))}
        <div className="total-recurring-time">
          <strong>Total recurring time today: {formatRecurringTime(recurringTimeSpent)}</strong>
        </div>
      </div>
    ) : (
      <div className="no-recurring-tasks">
        <p>No recurring tasks available</p>
      </div>
    )}
  </div>
        
        {/* Task Section */}
        <div className="main-content-area">
          <div className="current-task-section">
            <h3 className="section-title">Current Priority Task</h3>
            
            {activeTask ? (
              <div className="current-task">
                <div className={`task-card priority-${activeTask.priority || '5'}`}>
                  <h4 className="task-title">{activeTask.title}</h4>
                  <div className="task-meta">
                    <div className="meta-item due-date">
                      <label>Target Date:</label>
                      <input
                        type="date"
                        value={activeTask.dueDate || ''}
                        onChange={(e) => {
                          console.log("Date input changed to:", e.target.value);
                          updateTaskProperty(activeTask.id, 'dueDate', e.target.value);
                        }}
                      />
                    </div>
                    <div className="meta-item priority">
                      <label>Priority:</label>
                      <select
                        value={activeTask.priority || '5'}
                        onChange={(e) => updateTaskProperty(activeTask.id, 'priority', e.target.value)}
                      >
                        <option value="1">{priorityDescriptions['1']}</option>
                        <option value="2">{priorityDescriptions['2']}</option>
                        <option value="3">{priorityDescriptions['3']}</option>
                        <option value="4">{priorityDescriptions['4']}</option>
                        <option value="5">{priorityDescriptions['5']}</option>
                      </select>
                    </div>
                    <span className="meta-item time-spent">
                      Time spent: {Math.floor(activeTask.timeSpent / 60)}m
                    </span>
                    <span className="meta-item time-spent-today">
                      Time spent today: {Math.floor((activeTask.timeSpentToday || 0) / 60)}m
                    </span>
                  </div>
                </div>
                
                <div className="task-navigation">
                  <button 
                    onClick={goToPreviousTask}
                    className="nav-button prev"
                    disabled={sortedTasks.length <= 1}
                  >
                    Previous
                  </button>
                  <button 
                    onClick={completeTask}
                    className="action-button complete"
                  >
                    Mark Complete
                  </button>
                  <button 
                    onClick={goToNextTask}
                    className="nav-button next"
                    disabled={sortedTasks.length <= 1}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : (
              <div className="no-tasks">
                <p>No non-recurring tasks available.</p>
                <button 
                  onClick={() => setActiveView('tasks')}
                  className="action-button"
                >
                  Add More Tasks
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;