import transporter from './transporter.js';
import { buildReminderEmail } from './reminderTemplate.js';

export async function sendDueReminder({ to, assigneeName, taskName, dueDate }) {
  try {
    const mailOptions = buildReminderEmail({ to, assigneeName, taskName, dueDate });
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email] Sent to ${to} — ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Email] Failed for ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}