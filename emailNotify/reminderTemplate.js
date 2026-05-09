import "dotenv/config";

export function buildReminderEmail({ to, assigneeName, taskName, dueDate }) {
  return {
    from: `"HR365 TMS" <${process.env.EMAIL_USER}>`,
    to,
    subject: `Reminder: "${taskName}" is due on ${dueDate}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;">
        <h2 style="color:#0078d4;">Task Due Reminder</h2>
        <p>Hi <strong>${assigneeName}</strong>,</p>
        <p>This is a reminder that the following task is still pending:</p>
        <table style="border-collapse:collapse;width:100%;">
          <tr>
            <td style="padding:8px;border:1px solid #ddd;background:#f4f4f4;"><strong>Task</strong></td>
            <td style="padding:8px;border:1px solid #ddd;">${taskName}</td>
          </tr>
          <tr>
            <td style="padding:8px;border:1px solid #ddd;background:#f4f4f4;"><strong>Due Date</strong></td>
            <td style="padding:8px;border:1px solid #ddd;color:#d83b01;">${dueDate}</td>
          </tr>
        </table>
        <p>Please complete your pending items as soon as possible.</p>
        <a href="https://yourapp.com/tasks"
          style="display:inline-block;margin-top:16px;padding:10px 20px;
                 background:#0078d4;color:#fff;border-radius:4px;text-decoration:none;">
          View My Tasks
        </a>
        <p style="margin-top:24px;font-size:12px;color:#888;">
          HR365 TMS · Automated Notification
        </p>
      </div>
    `,
  };
}