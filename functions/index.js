const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

/**
 * Scheduled Cloud Function that runs every hour
 * Checks for upcoming birthdays and sends push notifications
 */
exports.sendBirthdayReminders = functions.pubsub
    .schedule('0 * * * *')  // Runs at minute 0 of every hour
    .timeZone('Asia/Kolkata')  // IST timezone
    .onRun(async (context) => {
        console.log('Running birthday reminder check... hehe');

        // Get current time in IST
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
        const istNow = new Date(now.getTime() + istOffset);

        // Extract IST date components
        const currentHour = istNow.getUTCHours();
        const currentDate = istNow.getUTCDate();
        const currentMonth = istNow.getUTCMonth();
        const currentYear = istNow.getUTCFullYear();

        console.log(`UTC time: ${now.toISOString()}, IST time: ${istNow.toISOString()}, IST Hour: ${currentHour}`);

        try {
            // Get all users
            const usersSnapshot = await db.collection('users').get();
            console.log(`Found ${usersSnapshot.size} users`);

            for (const userDoc of usersSnapshot.docs) {
                const userData = userDoc.data();
                const userId = userDoc.id;
                const fcmTokens = userData.fcmTokens || [];
                console.log(`Processing user ${userId}, FCM tokens: ${fcmTokens.length}`);

                if (fcmTokens.length === 0) {
                    console.log(`User ${userId} has no FCM tokens, skipping`);
                    continue;
                }

                // Get user's notification settings
                const settingsDoc = await db.collection('users').doc(userId)
                    .collection('settings').doc('notifications').get();

                let notificationSettings = {
                    enabled: true,
                    reminders: [{ id: 'default', label: 'Day of (12 AM)', hours: 0 }]
                };

                if (settingsDoc.exists && settingsDoc.data().settings) {
                    notificationSettings = settingsDoc.data().settings;
                }
                console.log(`User ${userId} notification settings: enabled=${notificationSettings.enabled}, reminders=${JSON.stringify(notificationSettings.reminders)}`);

                if (!notificationSettings.enabled) {
                    console.log(`User ${userId} has notifications disabled, skipping`);
                    continue;
                }

                // Get user's birthdays
                const birthdaysSnapshot = await db.collection('users').doc(userId)
                    .collection('birthdays').get();
                console.log(`User ${userId} has ${birthdaysSnapshot.size} birthdays`);

                for (const bdayDoc of birthdaysSnapshot.docs) {
                    const birthday = bdayDoc.data();
                    const eventDate = new Date(birthday.date);
                    console.log(`  Checking birthday: ${birthday.name}, date: ${birthday.date}`);

                    // Calculate this year's occurrence (using IST date components)
                    const eventMonth = eventDate.getMonth();
                    const eventDay = eventDate.getDate();

                    // Create event date for this year at midnight IST
                    // We compare using month/day directly
                    let thisYearEventMonth = eventMonth;
                    let thisYearEventDay = eventDay;
                    let thisYearEventYear = currentYear;

                    // Check if event has passed this year (compare in IST)
                    if (eventMonth < currentMonth ||
                        (eventMonth === currentMonth && eventDay < currentDate)) {
                        thisYearEventYear = currentYear + 1;
                    }
                    console.log(`  This year event: ${thisYearEventYear}-${thisYearEventMonth + 1}-${thisYearEventDay}`);

                    // Check each reminder
                    for (const reminder of notificationSettings.reminders) {
                        // Calculate when this reminder should fire
                        // The event is at midnight IST on the event day
                        // reminder.hours is how many hours BEFORE the event to notify

                        // Calculate notification date/hour in IST
                        // Start from event date at midnight (hour 0) and subtract reminder.hours
                        const hoursToSubtract = reminder.hours;
                        const daysToSubtract = Math.floor(hoursToSubtract / 24);
                        const remainingHours = hoursToSubtract % 24;

                        // Notification day
                        let notifDay = thisYearEventDay - daysToSubtract;
                        let notifMonth = thisYearEventMonth;
                        let notifYear = thisYearEventYear;

                        // Handle month/year underflow
                        if (notifDay <= 0) {
                            notifMonth--;
                            if (notifMonth < 0) {
                                notifMonth = 11;
                                notifYear--;
                            }
                            // Get days in the previous month
                            const daysInPrevMonth = new Date(notifYear, notifMonth + 1, 0).getDate();
                            notifDay += daysInPrevMonth;
                        }

                        // Notification hour - if subtracting hours from midnight
                        let notifHour = (24 - remainingHours) % 24;
                        if (remainingHours > 0) {
                            // If we're subtracting hours, we need to go back one more day
                            notifDay--;
                            if (notifDay <= 0) {
                                notifMonth--;
                                if (notifMonth < 0) {
                                    notifMonth = 11;
                                    notifYear--;
                                }
                                const daysInPrevMonth = new Date(notifYear, notifMonth + 1, 0).getDate();
                                notifDay += daysInPrevMonth;
                            }
                        } else {
                            notifHour = 0; // Midnight of the event day
                        }

                        console.log(`    Reminder: ${reminder.label} (${reminder.hours}h), notification: ${notifYear}-${notifMonth + 1}-${notifDay} at ${notifHour}:00 IST`);

                        // Check if this is the exact date and hour to send the notification
                        const shouldSend = notifDay === currentDate &&
                            notifMonth === currentMonth &&
                            notifYear === currentYear &&
                            notifHour === currentHour;

                        console.log(`    Should send now? ${shouldSend} (notif: ${notifYear}-${notifMonth + 1}-${notifDay} ${notifHour}:00, current: ${currentYear}-${currentMonth + 1}-${currentDate} ${currentHour}:00)`);

                        if (shouldSend) {

                            // Check if already sent (prevent duplicates)
                            const notifKey = `${userId}-${bdayDoc.id}-${reminder.id}-${now.getFullYear()}`;
                            const sentDoc = await db.collection('sentNotifications').doc(notifKey).get();

                            if (sentDoc.exists) {
                                console.log(`Notification ${notifKey} already sent, skipping`);
                                continue;
                            }

                            // Build notification message
                            let message;
                            const eventType = birthday.customType || birthday.type || 'Birthday';

                            if (reminder.hours === 0) {
                                message = `🎉 Today is ${birthday.name}'s ${eventType}!`;
                            } else if (reminder.hours < 24) {
                                message = `⏰ ${birthday.name}'s ${eventType} is in ${reminder.hours} hours!`;
                            } else {
                                const days = Math.floor(reminder.hours / 24);
                                message = `📅 ${birthday.name}'s ${eventType} is in ${days} day${days > 1 ? 's' : ''}!`;
                            }

                            // Send data-only message (service worker will display notification)
                            const payload = {
                                data: {
                                    title: 'Moments Reminder 🎉',
                                    body: message,
                                    tag: `moment-${bdayDoc.id}`,
                                    personId: bdayDoc.id,
                                    personName: birthday.name
                                }
                            };

                            // Send to each token
                            const invalidTokens = [];
                            for (const token of fcmTokens) {
                                try {
                                    await messaging.send({
                                        token: token,
                                        ...payload
                                    });
                                    console.log(`Notification sent to user ${userId} for ${birthday.name}`);
                                } catch (sendError) {
                                    console.error(`Error sending to token: ${sendError.message}`);
                                    // Check if token is invalid
                                    if (sendError.code === 'messaging/invalid-registration-token' ||
                                        sendError.code === 'messaging/registration-token-not-registered') {
                                        invalidTokens.push(token);
                                    }
                                }
                            }

                            // Remove invalid tokens
                            if (invalidTokens.length > 0) {
                                await db.collection('users').doc(userId).update({
                                    fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
                                });
                                console.log(`Removed ${invalidTokens.length} invalid tokens for user ${userId}`);
                            }

                            // Mark notification as sent
                            await db.collection('sentNotifications').doc(notifKey).set({
                                sentAt: admin.firestore.FieldValue.serverTimestamp(),
                                userId: userId,
                                birthdayId: bdayDoc.id,
                                reminderId: reminder.id
                            });
                        }
                    }
                }
            }

            console.log('Birthday reminder check completed');
            return null;
        } catch (error) {
            console.error('Error in sendBirthdayReminders:', error);
            throw error;
        }
    });

/**
 * HTTP function to manually trigger notification check (for testing)
 * Call this via: https://us-central1-YOUR_PROJECT.cloudfunctions.net/testNotification
 */
exports.testNotification = functions.https.onRequest(async (req, res) => {
    // Enable CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight request
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    // Only allow POST requests
    if (req.method !== 'POST') {
        res.status(405).send('Method not allowed');
        return;
    }

    const { userId, message } = req.body;

    if (!userId || !message) {
        res.status(400).send('Missing userId or message');
        return;
    }

    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists) {
            res.status(404).send('User not found');
            return;
        }

        const fcmTokens = userDoc.data().fcmTokens || [];
        console.log(`User ${userId} has ${fcmTokens.length} FCM tokens`);

        if (fcmTokens.length === 0) {
            res.status(400).send('User has no FCM tokens');
            return;
        }

        // Use data-only message (no 'notification' key) so FCM doesn't auto-display
        // The service worker will handle showing the notification
        const payload = {
            data: {
                title: 'Test Notification 🧪',
                body: message,
                tag: 'test-notification'
            }
        };

        let successCount = 0;
        let failedTokens = [];

        for (const token of fcmTokens) {
            console.log(`Sending to token: ${token.substring(0, 20)}...`);
            try {
                await messaging.send({
                    token: token,
                    ...payload
                });
                successCount++;
                console.log(`Success for token: ${token.substring(0, 20)}...`);
            } catch (tokenError) {
                console.error(`Failed for token ${token.substring(0, 20)}...: ${tokenError.message}`);
                failedTokens.push(token);
            }
        }

        // Remove failed tokens from user's document
        if (failedTokens.length > 0) {
            await db.collection('users').doc(userId).update({
                fcmTokens: admin.firestore.FieldValue.arrayRemove(...failedTokens)
            });
            console.log(`Removed ${failedTokens.length} invalid tokens`);
        }

        if (successCount > 0) {
            res.status(200).send(`Notification sent to ${successCount} device(s). ${failedTokens.length} invalid token(s) removed.`);
        } else {
            res.status(400).send(`All ${fcmTokens.length} tokens failed. They have been removed. User needs to re-enable notifications.`);
        }
    } catch (error) {
        console.error('Test notification error:', error);
        res.status(500).send(`Error: ${error.message}`);
    }
});

/**
 * Cleanup old sent notifications (runs daily)
 * Removes notification records older than 30 days
 */
exports.cleanupOldNotifications = functions.pubsub
    .schedule('0 3 * * *')  // Runs at 3 AM daily
    .timeZone('Asia/Kolkata')
    .onRun(async (context) => {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        try {
            const oldNotifications = await db.collection('sentNotifications')
                .where('sentAt', '<', thirtyDaysAgo)
                .get();

            const batch = db.batch();
            oldNotifications.docs.forEach(doc => {
                batch.delete(doc.ref);
            });

            await batch.commit();
            console.log(`Cleaned up ${oldNotifications.size} old notification records`);
            return null;
        } catch (error) {
            console.error('Cleanup error:', error);
            throw error;
        }
    });
