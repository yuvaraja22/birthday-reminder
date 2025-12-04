// Notification Settings Functions

let notificationSettings = {
    enabled: true,
    reminders: [
        { id: 'default', label: 'Day of (12 AM)', hours: 0 }
    ]
};

function loadNotificationSettings() {
    // Try localStorage first
    const stored = localStorage.getItem('notification-settings');
    if (stored) {
        try {
            notificationSettings = JSON.parse(stored);
        } catch (e) {
            console.error('Failed to parse notification settings:', e);
        }
    }

    // If logged in, load from Firebase
    if (currentUser && isFirebaseReady) {
        db.collection('users').doc(currentUser.uid).collection('settings').doc('notifications').get()
            .then(doc => {
                if (doc.exists && doc.data().settings) {
                    notificationSettings = doc.data().settings;
                    renderRemindersList();
                }
            })
            .catch(err => console.error('Error loading notification settings:', err));
    }

    // Update UI
    if (document.getElementById('notifications-enabled')) {
        document.getElementById('notifications-enabled').checked = notificationSettings.enabled;
    }
}

function saveNotificationSettings() {
    // Save to localStorage
    localStorage.setItem('notification-settings', JSON.stringify(notificationSettings));

    // If logged in, save to Firebase
    if (currentUser && isFirebaseReady) {
        db.collection('users').doc(currentUser.uid).collection('settings').doc('notifications').set({
            settings: notificationSettings,
            updatedAt: new Date().toISOString()
        }).catch(err => console.error('Error saving notification settings:', err));
    }

    renderRemindersList();
}

function toggleNotifications() {
    const enabled = document.getElementById('notifications-enabled').checked;
    notificationSettings.enabled = enabled;
    saveNotificationSettings();

    if (enabled) {
        requestNotificationPermission();
    }
}

function addReminderPreset(hours, label) {
    // Check if already exists
    const exists = notificationSettings.reminders.some(r => r.hours === hours);
    if (exists) {
        showToast('Reminder already exists', true);
        return;
    }

    const newReminder = {
        id: Date.now().toString(),
        label: label,
        hours: hours
    };

    notificationSettings.reminders.push(newReminder);
    saveNotificationSettings();
    showToast('Reminder added!');
}

function addCustomReminder() {
    const hoursInput = document.getElementById('custom-hours');
    const hours = parseInt(hoursInput.value);

    if (isNaN(hours) || hours < 0) {
        showToast('Please enter valid hours', true);
        return;
    }

    // Check if already exists
    const exists = notificationSettings.reminders.some(r => r.hours === hours);
    if (exists) {
        showToast('Reminder already exists', true);
        return;
    }

    let label;
    if (hours === 0) {
        label = 'Day of (12 AM)';
    } else if (hours < 24) {
        label = `${hours} hour${hours > 1 ? 's' : ''} before`;
    } else {
        const days = Math.floor(hours / 24);
        label = `${days} day${days > 1 ? 's' : ''} before`;
    }

    const newReminder = {
        id: Date.now().toString(),
        label: label,
        hours: hours
    };

    notificationSettings.reminders.push(newReminder);
    saveNotificationSettings();
    showToast('Reminder added!');

    hoursInput.value = '';
}

function deleteReminder(id) {
    if (notificationSettings.reminders.length <= 1) {
        showToast('Must have at least one reminder', true);
        return;
    }

    notificationSettings.reminders = notificationSettings.reminders.filter(r => r.id !== id);
    saveNotificationSettings();
    showToast('Reminder removed');
}

function renderRemindersList() {
    const list = document.getElementById('reminders-list');
    if (!list) return;

    list.innerHTML = '';

    // Sort by hours (ascending)
    const sorted = [...notificationSettings.reminders].sort((a, b) => a.hours - b.hours);

    sorted.forEach(reminder => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between bg-slate-50 px-4 py-3 rounded-xl hover:bg-slate-100 transition';

        div.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <i class="fa-solid fa-clock text-primary text-sm"></i>
                </div>
                <div>
                    <p class="font-medium text-slate-800 text-sm">${reminder.label}</p>
                </div>
            </div>
            ${notificationSettings.reminders.length > 1 ? `
                <button onclick="deleteReminder('${reminder.id}')" class="text-slate-400 hover:text-red-600 transition px-2">
                    <i class="fa-solid fa-trash text-sm"></i>
                </button>
            ` : ''}
        `;

        list.appendChild(div);
    });
}

function openSettingsModal() {
    loadNotificationSettings();
    renderRemindersList();
    toggleModal('settings-modal');
}
