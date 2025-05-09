import express from 'express';
import { calculateRate, getHistory } from '../controllers/freightController.js';

const router = express.Router();

// POST /api/calculate - расчет ставки
router.post('/calculate', calculateRate);

// GET /api/history - история расчетов
router.get('/history', getHistory);

export default router;
