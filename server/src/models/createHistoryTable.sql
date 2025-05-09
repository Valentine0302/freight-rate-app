CREATE TABLE IF NOT EXISTS calculation_history (
  id SERIAL PRIMARY KEY,
  origin_port_id VARCHAR(10),
  destination_port_id VARCHAR(10),
  container_type VARCHAR(10),
  weight INTEGER,
  rate NUMERIC,
  email VARCHAR(255),
  sources TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
