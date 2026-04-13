// ─── To connect to a real database, set up your .env file: ───────────────────
// DB_HOST=localhost
// DB_PORT=3306 (or 5432 for PostgreSQL)
// DB_USER=root
// DB_PASSWORD=yourpassword
// DB_NAME=resource_db
//
// Then replace the in-memory array below with your DB query functions.
// Example (MySQL with mysql2):
//   const db = require("../config/db"); // your db connection file
//   const [rows] = await db.query("SELECT * FROM resources");
// ─────────────────────────────────────────────────────────────────────────────

let resources = [
  {
    id: 1,
    name: "Poland Cement",
    supplier: "BuildMart Supply Co.",
    category: "Material",
    quantity: 45,
    unit: "tons",
    minThreshold: 20,
    unitPrice: 6500,
    project: "Downtown Office Complex",
    status: "In stock",
    updatedAt: "2026-04-05",
  },
  {
    id: 2,
    name: "Steel Rebar",
    supplier: "Steel Solutions Inc.",
    category: "Material",
    quantity: 15,
    unit: "tons",
    minThreshold: 25,
    unitPrice: 45000,
    project: "Downtown Office Complex",
    status: "Low stock",
    updatedAt: "2026-04-05",
  },
  {
    id: 3,
    name: "Ready-Mix Concrete",
    supplier: "Concrete Express Ltd.",
    category: "Material",
    quantity: 120,
    unit: "m³",
    minThreshold: 50,
    unitPrice: 5400,
    project: "Riverside Bridge Renovation",
    status: "In stock",
    updatedAt: "2026-04-07",
  },
  {
    id: 4,
    name: "Construction Sand",
    supplier: "Aggregate Suppliers Ltd.",
    category: "Material",
    quantity: 8,
    unit: "tons",
    minThreshold: 15,
    unitPrice: 2000,
    project: "Riverside Bridge Renovation",
    status: "Low stock",
    updatedAt: "2026-04-07",
  },
  {
    id: 5,
    name: "Excavator",
    supplier: "Heavy Machinery Rentals",
    category: "Equipment",
    quantity: 3,
    unit: "units",
    minThreshold: 2,
    unitPrice: 4800000,
    project: "Downtown Office Complex",
    status: "Available",
    updatedAt: "2026-04-06",
  },
  {
    id: 6,
    name: "Tower Crane",
    supplier: "Skyline Equipment Co.",
    category: "Equipment",
    quantity: 1,
    unit: "units",
    minThreshold: 1,
    unitPrice: 14000000,
    project: "Downtown Office Complex",
    status: "Low Availability",
    updatedAt: "2026-04-06",
  },
];

// ─── Helper: auto-compute status from quantity vs minThreshold ────────────────
function computeStatus(category, quantity, minThreshold) {
  const isLow = quantity <= minThreshold;
  if (category === "Equipment") return isLow ? "Low Availability" : "Available";
  return isLow ? "Low stock" : "In stock";
}

// ─── GET all (with optional filters) ─────────────────────────────────────────
// TODO (DB): Replace with → SELECT * FROM resources WHERE ...
const getAllResources = async ({ search, category, status, project } = {}) => {
  let result = [...resources];

  if (search) {
    const q = search.toLowerCase();
    result = result.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.supplier.toLowerCase().includes(q)
    );
  }
  if (category) result = result.filter((r) => r.category === category);
  if (status)   result = result.filter((r) => r.status === status);
  if (project)  result = result.filter((r) => r.project === project);

  return result;
};

// ─── GET by ID ────────────────────────────────────────────────────────────────
// TODO (DB): Replace with → SELECT * FROM resources WHERE id = ?
const getResourceById = async (id) => {
  return resources.find((r) => r.id === Number(id)) || null;
};

// ─── CREATE ───────────────────────────────────────────────────────────────────
// TODO (DB): Replace with → INSERT INTO resources (...) VALUES (...)
const createResource = async (body) => {
  const { name, supplier, category, quantity, unit, minThreshold, unitPrice, project } = body;

  if (!name || !category || quantity == null || !unit || !project || unitPrice == null) {
    const err = new Error("Missing required fields");
    err.statusCode = 400;
    throw err;
  }

  const qty = Number(quantity);
  const min = Number(minThreshold) || 0;

  const newResource = {
    id: Date.now(),
    name,
    supplier: supplier || "",
    category,
    quantity: qty,
    unit,
    minThreshold: min,
    unitPrice: Number(unitPrice),
    project,
    status: computeStatus(category, qty, min),
    updatedAt: new Date().toISOString().slice(0, 10),
  };

  resources.push(newResource);
  return newResource;
};

// ─── UPDATE ───────────────────────────────────────────────────────────────────
// TODO (DB): Replace with → UPDATE resources SET ... WHERE id = ?
const updateResource = async (id, body) => {
  const index = resources.findIndex((r) => r.id === Number(id));
  if (index === -1) return null;

  const existing = resources[index];
  const newCategory    = body.category     ?? existing.category;
  const newQty         = body.quantity     != null ? Number(body.quantity)     : existing.quantity;
  const newMin         = body.minThreshold != null ? Number(body.minThreshold) : existing.minThreshold;
  const newUnitPrice   = body.unitPrice    != null ? Number(body.unitPrice)    : existing.unitPrice;

  const updated = {
    ...existing,
    name:         body.name      ?? existing.name,
    supplier:     body.supplier  ?? existing.supplier,
    category:     newCategory,
    quantity:     newQty,
    unit:         body.unit      ?? existing.unit,
    minThreshold: newMin,
    unitPrice:    newUnitPrice,
    project:      body.project   ?? existing.project,
    status:       computeStatus(newCategory, newQty, newMin),
    updatedAt:    new Date().toISOString().slice(0, 10),
  };

  resources[index] = updated;
  return updated;
};

// ─── DELETE ───────────────────────────────────────────────────────────────────
// TODO (DB): Replace with → DELETE FROM resources WHERE id = ?
const deleteResource = async (id) => {
  const index = resources.findIndex((r) => r.id === Number(id));
  if (index === -1) return null;
  resources.splice(index, 1);
  return true;
};

module.exports = {
  getAllResources,
  getResourceById,
  createResource,
  updateResource,
  deleteResource,
};