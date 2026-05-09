import { Router } from 'express';
import { sendDueReminder } from './sendReminder.js';
const router = Router();

// POST /api/notify/remind  ← called from React UI (manual trigger)
router.post('/remind', async (req, res) => {
  const { to, assigneeName, taskName, dueDate } = req.body;

  if (!to || !taskName || !dueDate) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  const result = await sendDueReminder({ to, assigneeName, taskName, dueDate });
  res.status(result.success ? 200 : 500).json(result);
});

export default router;