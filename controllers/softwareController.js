const softwareService = require('../services/softwareService');

exports.getAllSoftware = async (req, res) => {
  try {
    const data = await softwareService.getAllSoftware();
    return res.json({ data });
  } catch (err) {
    console.error('GetAllSoftware error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.getSoftwareById = async (req, res) => {
  try {
    const software = await softwareService.getSoftwareById(req.params.id);
    if (!software) return res.status(404).json({ error: 'Software not found.' });
    return res.json({ data: software });
  } catch (err) {
    console.error('GetSoftwareById error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.getSoftwareByProject = async (req, res) => {
  try {
    const data = await softwareService.getSoftwareByProject(req.params.projectId);
    return res.json({ data });
  } catch (err) {
    console.error('GetSoftwareByProject error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.createSoftware = async (req, res) => {
  try {
    const { name, version, description, license_key, status, project_id } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Software name is required.' });
    }

    const data = await softwareService.createSoftware({
      name:        name.trim(),
      version:     version?.trim()      ?? null,
      description: description?.trim()  ?? null,
      license_key: license_key?.trim()  ?? null,
      status:      status               ?? 'active',
      project_id:  project_id           ?? null,
    });

    return res.status(201).json({ message: 'Software created.', data });
  } catch (err) {
    console.error('CreateSoftware error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.updateSoftware = async (req, res) => {
  try {
    if (Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: 'No fields provided to update.' });
    }

    const data = await softwareService.updateSoftware(req.params.id, req.body);
    if (!data) return res.status(404).json({ error: 'Software not found.' });

    return res.json({ message: 'Software updated.', data });
  } catch (err) {
    console.error('UpdateSoftware error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

exports.deleteSoftware = async (req, res) => {
  try {
    const deleted = await softwareService.deleteSoftware(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Software not found.' });
    return res.json({ message: 'Software deleted.' });
  } catch (err) {
    console.error('DeleteSoftware error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};