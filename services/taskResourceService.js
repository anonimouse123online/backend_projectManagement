const keyOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

function materialItems(value) {
  if (Array.isArray(value)) return value.map(item => ({ ...item }));
  if (typeof value !== 'string' || !value.trim() || ['none', 'none specified'].includes(keyOf(value))) return [];
  if (value.trim().startsWith('[')) {
    try {
      const items = JSON.parse(value);
      if (Array.isArray(items) && items.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
        return items;
      }
    } catch { /* Older free text remains readable even when it starts with a bracket. */ }
  }
  return value.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    // Create Task formats its existing material text as "quantity unit name".
    const match = part.match(/^(\d+(?:\.\d+)?)\s+(\S+)\s+(.+)$/);
    return match ? { name: match[3], quantity: Number(match[1]), unit: match[2] }
      : { name: part, quantity: null, unit: null };
  });
}

// Only call with tasks already selected by the controller's existing access checks.
async function withResources(tasks, db) {
  if (!tasks.length) return [];
  const projectKeys = [...new Set(tasks.map(task => keyOf(task.project_name)).filter(Boolean))];
  const { rows } = await db.query(`SELECT r.task_id, LOWER(TRIM(r.project)) AS project_key,
    jsonb_build_object('id', r.id, 'name', r.name, 'category', r.category,
      'quantity', r.quantity, 'unit', r.unit, 'supplier', r.supplier,
      'unitPrice', r.unit_price, 'taskId', r.task_id, 'taskName', r.task_name) AS resource
    FROM resources r
    WHERE r.task_id = ANY($1::uuid[])
      OR (r.task_id IS NULL AND LOWER(TRIM(r.project)) = ANY($2::text[]))
    ORDER BY r.id`, [tasks.map(task => task.id), projectKeys]);

  return tasks.map(task => {
    const projectKey = keyOf(task.project_name);
    const taskName = keyOf(task.task_name);
    const unlinked = rows.filter(row => row.task_id == null && row.project_key === projectKey &&
      (!keyOf(row.resource.taskName) || keyOf(row.resource.taskName) === taskName));
    const resources = rows.filter(row => String(row.task_id) === String(task.id) ||
      (row.task_id == null && row.project_key === projectKey && taskName && keyOf(row.resource.taskName) === taskName))
      .map(row => row.resource);
    const metadata = [...resources, ...unlinked.map(row => row.resource)];
    const allocatedMaterials = materialItems(task.materials_required).map(item => {
      const resource = metadata.find(candidate => keyOf(candidate.name) === keyOf(item.name));
      return {
        ...item,
        category: item.category ?? resource?.category ?? null,
        // An unlinked resource's quantity is project stock, never a task allocation.
        quantity: item.quantity ?? null,
        unit: item.unit ?? resource?.unit ?? null,
        supplier: item.supplier ?? resource?.supplier ?? null,
        unitPrice: item.unitPrice ?? item.unit_price ?? resource?.unitPrice ?? null,
      };
    });
    return { ...task, resources, allocated_materials: allocatedMaterials };
  });
}

module.exports = { materialItems, withResources };
