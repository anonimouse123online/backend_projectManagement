const pool = require('../db');

// GET /timelogs
exports.getTimelogs = async (req, res) => {
  const startTime = Date.now();

  console.log('\n══════════════════════════════════════');
  console.log('🕒 [TIME LOGS] GET /timelogs');
  console.log('══════════════════════════════════════');

  try {
    const { search, date, engineer } = req.query;

    const conditions = [];
    const params = [];

    // Show incoming filters
    console.log('🔍 [TIME LOGS] Filters:', {
      search: search || 'None',
      date: date || 'All Dates',
      engineer: engineer || 'All Engineers'
    });

    // ==========================================
    // SEARCH FILTER
    // ==========================================
    if (search) {
      params.push(`%${search}%`);

      conditions.push(`
        (
          tl.project_name ILIKE $${params.length}
          OR tl.engineer_name ILIKE $${params.length}
          OR tl.work_completed ILIKE $${params.length}
          OR tl.materials_delivered ILIKE $${params.length}
          OR tl.equipment_used ILIKE $${params.length}
          OR tl.additional_notes ILIKE $${params.length}
        )
      `);
    }

    // ==========================================
    // DATE FILTER
    // ==========================================
    if (date) {
      params.push(date);

      conditions.push(`
        tl.date = $${params.length}::date
      `);
    }

    // ==========================================
    // ENGINEER FILTER
    // ==========================================
    if (engineer && engineer !== 'All Engineers') {
      params.push(`%${engineer}%`);

      conditions.push(`
        tl.engineer_name ILIKE $${params.length}
      `);
    }

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    const query = `
      SELECT
        tl.id,

        tl.project_name,

        COALESCE(
          tl.engineer_name,
          'Site Engineer'
        ) AS engineer_name,

        TO_CHAR(
          tl.date,
          'YYYY-MM-DD'
        ) AS date,

        COALESCE(
          tl.work_on_site,
          0
        ) AS work_on_site,

        COALESCE(
          tl.supervisors,
          0
        ) AS supervisors,

        COALESCE(
          tl.sub_contractors,
          0
        ) AS sub_contractors,

        COALESCE(
          tl.total_work_hours,
          '0'
        ) AS total_work_hours,

        COALESCE(
          tl.weather,
          'Sunny'
        ) AS weather,

        tl.temperature,

        COALESCE(
          tl.work_completed,
          ''
        ) AS work_completed,

        COALESCE(
          tl.materials_delivered,
          ''
        ) AS materials_delivered,

        COALESCE(
          tl.equipment_used,
          ''
        ) AS equipment_used,

        COALESCE(
          tl.additional_notes,
          ''
        ) AS additional_notes,

        COALESCE(
          tl.has_incident,
          false
        ) AS has_incident,

        tl.created_at,
        tl.updated_at

      FROM time_logs tl

      ${whereClause}

      ORDER BY tl.created_at DESC
    `;

    console.log('📡 [TIME LOGS] Querying PostgreSQL...');
    console.log('📦 [TIME LOGS] Query params:', params);

    const { rows } = await pool.query(query, params);

    const duration = Date.now() - startTime;

    // ==========================================
    // SUCCESS TERMINAL STATUS
    // ==========================================
    console.log('✅ [TIME LOGS] Request successful');
    console.log(`📋 [TIME LOGS] ${rows.length} time log(s) found`);
    console.log(`⚡ [TIME LOGS] Completed in ${duration}ms`);

    // Optional: display logs as terminal table
    if (rows.length > 0) {
      console.table(
        rows.map(log => ({
          id: log.id,
          project: log.project_name,
          engineer: log.engineer_name,
          date: log.date,
          workers: log.work_on_site,
          hours: log.total_work_hours,
          weather: log.weather,
          incident: log.has_incident
        }))
      );
    } else {
      console.log('ℹ️ [TIME LOGS] No time logs found.');
    }

    console.log('══════════════════════════════════════\n');

    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });

  } catch (err) {
    const duration = Date.now() - startTime;

    // ==========================================
    // ERROR TERMINAL STATUS
    // ==========================================
    console.error('❌ [TIME LOGS] Request failed');
    console.error('❌ [TIME LOGS] Error:', err.message);
    console.error('❌ [TIME LOGS] PostgreSQL code:', err.code || 'N/A');
    console.error(`⚡ [TIME LOGS] Failed after ${duration}ms`);
    console.error('══════════════════════════════════════\n');

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch time logs.',
      message: err.message
    });
  }
};