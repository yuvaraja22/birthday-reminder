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
        console.log('Running birthday reminder check...');

        const now = new Date();
        const currentHour = now.getHours();

        try {
            // Get all users
            const usersSnapshot = await db.collection('users').get();

            for (const userDoc of usersSnapshot.docs) {
                const userData = userDoc.data();
                const userId = userDoc.id;
                const fcmTokens = userData.fcmTokens || [];

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

                if (!notificationSettings.enabled) {
                    console.log(`User ${userId} has notifications disabled, skipping`);
                    continue;
                }

                // Get user's birthdays
                const birthdaysSnapshot = await db.collection('users').doc(userId)
                    .collection('birthdays').get();

                for (const bdayDoc of birthdaysSnapshot.docs) {
                    const birthday = bdayDoc.data();
                    const eventDate = new Date(birthday.date);

                    // Calculate this year's occurrence
                    let thisYearEvent = new Date(now.getFullYear(), eventDate.getMonth(), eventDate.getDate());
                    if (thisYearEvent < now) {
                        thisYearEvent.setFullYear(now.getFullYear() + 1);
                    }

                    // Check each reminder
                    for (const reminder of notificationSettings.reminders) {
                        // Calculate when this reminder should fire
                        const notificationTime = new Date(thisYearEvent.getTime() - (reminder.hours * 60 * 60 * 1000));

                        // Check if this is the hour to send the notification
                        if (notificationTime.getDate() === now.getDate() &&
                            notificationTime.getMonth() === now.getMonth() &&
                            notificationTime.getFullYear() === now.getFullYear() &&
                            notificationTime.getHours() === currentHour) {

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

                            // Send to all user's FCM tokens
                            const payload = {
                                notification: {
                                    title: 'Moments Reminder 🎉',
                                    body: message
                                },
                                data: {
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
        if (fcmTokens.length === 0) {
            res.status(400).send('User has no FCM tokens');
            return;
        }

        const payload = {
            notification: {
                title: 'Test Notification 🧪',
                body: message
            }
        };

        for (const token of fcmTokens) {
            await messaging.send({
                token: token,
                ...payload
            });
        }

        res.status(200).send(`Notification sent to ${fcmTokens.length} devices`);
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
