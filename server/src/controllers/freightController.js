import { calculateFreightRate, saveRequestToHistory } from '../services/freightCalculator.js';

// POST /api/calculate
export async function calculateRate(req, res) {
  try {
    const {
      originPortId,
      destinationPortId,
      containerType,
      baseRatesConfig,
      indexConfig,
      sensitivityCoeff,
      email
    } = req.body;

    // Фиксированный вес
    const weight = 20000;

    const result = await calculateFreightRate(
      originPortId,
      destinationPortId,
      containerType,
      baseRatesConfig,
      indexConfig,
      sensitivityCoeff,
      weight,
      false // debugMode
    );

    if (result.finalRate !== -1) {
      await saveRequestToHistory(
        originPortId,
        destinationPortId,
        containerType,
        weight,
        result.finalRate,
        email || null,
        result.calculationDetails.indexSources
      );
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка на сервере', details: error.message });
  }
}

// GET /api/history
import pool from '../config/db.js';

export async function getHistory(req, res) {
  try {
    const result = await pool.query('SELECT * FROM calculation_history ORDER BY created_at DESC LIMIT 100');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка получения истории', details: error.message });
  }
}
