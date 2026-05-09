import cron from 'node-cron';
import { sendDueReminder } from './sendReminder.js';
async function getTasksDueTomorrow() {
  // Example: return await db.query(`SELECT ... WHERE due_date = NOW() + INTERVAL '1 day'`);
  return [
    {
      to: 'employee@example.com',
      assigneeName: 'John',
      taskName: 'Submit Timesheet',
      dueDate: '2026-04-19',
    },
  ];
}

// Runs every day at 9:00 AM
cron.schedule('0 9 * * *', async () => {
  console.log('[Cron] Checking due tasks...');

  const tasks = await getTasksDueTomorrow();

  const results = await Promise.all(tasks.map(task => sendDueReminder(task)));

  const sent = results.filter(r => r.success).length;
  console.log(`[Cron] ${sent}/${tasks.length} reminders sent.`);
});

console.log('[Cron] Due date scheduler registered.');