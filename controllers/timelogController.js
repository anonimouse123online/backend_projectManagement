const pool = require('../db');

// ============================================================
// GET /timelogs
// ============================================================
exports.getTimelogs = async (req, res) => {
  const startTime = Date.now();

  console.log('\n');
  console.log('════════════════════════════════════════════════════════════');
  console.log('🕒 [TIME LOGS API] GET /timelogs');
  console.log('════════════════════════════════════════════════════════════');

  try {
    const { search, date, engineer } = req.query;

    // ========================================================
    // DISPLAY REQUEST INFORMATION
    // ========================================================

    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    console.log('🌐 Method       :', req.method);
    console.log('🔗 API Endpoint :', req.originalUrl);
    console.log('🌍 Full API URL :', fullUrl);
    console.log('📅 Request Time :', new Date().toLocaleString());

    console.log('\n🔍 Filters');
    console.log('────────────────────────────────────────────────────────────');
    console.log('Search   :', search || 'None');
    console.log('Date     :', date || 'All Dates');
    console.log('Engineer :', engineer || 'All Engineers');

    const conditions = [];
    const params = [];

    // ========================================================
    // SEARCH FILTER
    // ========================================================

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

    // ========================================================
    // DATE FILTER
    // ========================================================

    if (date) {
      params.push(date);

      conditions.push(`
        tl.date = $${params.length}::date
      `);
    }

    // ========================================================
    // ENGINEER FILTER
    // ========================================================

    if (engineer && engineer !== 'All Engineers') {
      params.push(`%${engineer}%`);

      conditions.push(`
        tl.engineer_name ILIKE $${params.length}
      `);
    }

    // ========================================================
    // WHERE CLAUSE
    // ========================================================

    const whereClause =
      conditions.length > 0
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

    // ========================================================
    // POSTGRESQL QUERY
    // ========================================================

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

    // ========================================================
    // EXECUTE QUERY
    // ========================================================

    console.log('\n📡 PostgreSQL');
    console.log('────────────────────────────────────────────────────────────');
    console.log('📦 Query Params:', params);
    console.log('⏳ Querying database...');

    const { rows } = await pool.query(query, params);

    const duration = Date.now() - startTime;

    // ========================================================
    // CREATE API RESPONSE
    // ========================================================

    const apiResponse = {
      success: true,
      count: rows.length,
      data: rows
    };

    // ========================================================
    // TERMINAL STATUS
    // ========================================================

    console.log('\n✅ API REQUEST SUCCESS');
    console.log('────────────────────────────────────────────────────────────');
    console.log('🟢 HTTP Status : 200 OK');
    console.log(`📋 Records     : ${rows.length}`);
    console.log(`⚡ Duration    : ${duration}ms`);

    // ========================================================
    // DISPLAY CLEAN TABLE
    // ========================================================

    if (rows.length > 0) {
      console.log('\n📊 TIME LOG RECORDS');
      console.log('────────────────────────────────────────────────────────────');

      console.table(
        rows.map(log => ({
          ID: log.id,
          Project: log.project_name,
          Engineer: log.engineer_name,
          Date: log.date,
          Workers: log.work_on_site,
          Supervisors: log.supervisors,
          Subcontractors: log.sub_contractors,
          Hours: log.total_work_hours,
          Weather: log.weather,
          Temperature: log.temperature,
          Incident: log.has_incident ? 'YES' : 'NO'
        }))
      );
    } else {
      console.log('\nℹ️ No time logs found.');
    }

    // ========================================================
    // DISPLAY ACTUAL API JSON RESPONSE
    // ========================================================

    console.log('\n📤 API RESPONSE JSON');
    console.log('────────────────────────────────────────────────────────────');

    console.log(
      JSON.stringify(
        apiResponse,
        null,
        2
      )
    );

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🏁 [TIME LOGS API] REQUEST COMPLETED');
    console.log('════════════════════════════════════════════════════════════\n');

    // ========================================================
    // SEND RESPONSE
    // ========================================================

    return res.status(200).json(apiResponse);

  } catch (err) {
    const duration = Date.now() - startTime;

    // ========================================================
    // ERROR RESPONSE
    // ========================================================

    const errorResponse = {
      success: false,
      error: 'Failed to fetch time logs.',
      message: err.message
    };

    // ========================================================
    // ERROR TERMINAL LOG
    // ========================================================

    console.error('\n❌ API REQUEST FAILED');
    console.error('────────────────────────────────────────────────────────────');

    console.error('🌐 Method          :', req.method);
    console.error('🔗 Endpoint        :', req.originalUrl);
    console.error('🔴 HTTP Status     : 500');
    console.error('❌ Error Message   :', err.message);
    console.error('🐘 PostgreSQL Code :', err.code || 'N/A');
    console.error(`⚡ Duration        : ${duration}ms`);

    if (err.detail) {
      console.error('📋 Error Detail    :', err.detail);
    }

    if (err.hint) {
      console.error('💡 PostgreSQL Hint :', err.hint);
    }

    console.error('\n📤 ERROR API RESPONSE');
    console.error('────────────────────────────────────────────────────────────');

    console.error(
      JSON.stringify(
        errorResponse,
        null,
        2
      )
    );

    console.error('\n════════════════════════════════════════════════════════════');
    console.error('❌ [TIME LOGS API] REQUEST FAILED');
    console.error('════════════════════════════════════════════════════════════\n');

    return res.status(500).json(errorResponse);
  }
};
// ============================================================
// POST /timelogs
// CREATE NEW TIME LOG
// ============================================================
exports.createTimelog = async (req, res) => {
  const startTime = Date.now();

  console.log('\n');
  console.log('════════════════════════════════════════════════════════════');
  console.log('📝 [TIME LOGS API] POST /timelogs');
  console.log('════════════════════════════════════════════════════════════');

  try {
    // ========================================================
    // REQUEST INFORMATION
    // ========================================================

    const fullUrl =
      `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    console.log('🌐 Method       :', req.method);
    console.log('🔗 API Endpoint :', req.originalUrl);
    console.log('🌍 Full API URL :', fullUrl);
    console.log('📅 Request Time :', new Date().toLocaleString());

    console.log('\n📥 REQUEST BODY');
    console.log('────────────────────────────────────────────────────────────');

    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );

    // ========================================================
    // GET VALUES FROM REQUEST
    // ========================================================

    const {
      project_name,
      engineer_name,
      date,
      work_on_site,
      supervisors,
      sub_contractors,
      total_work_hours,
      weather,
      temperature,
      work_completed,
      materials_delivered,
      equipment_used,
      additional_notes,
      has_incident
    } = req.body;

    // ========================================================
    // VALIDATION
    // ========================================================

    if (!project_name || project_name.trim() === '') {
      console.log('\n⚠️ VALIDATION FAILED');
      console.log('❌ project_name is required.');

      return res.status(400).json({
        success: false,
        message: 'project_name is required.'
      });
    }

    if (!date) {
      console.log('\n⚠️ VALIDATION FAILED');
      console.log('❌ date is required.');

      return res.status(400).json({
        success: false,
        message: 'date is required.'
      });
    }

    // ========================================================
    // INSERT QUERY
    // ========================================================

    const query = `
      INSERT INTO time_logs (
        project_name,
        engineer_name,
        date,
        work_on_site,
        supervisors,
        sub_contractors,
        total_work_hours,
        weather,
        temperature,
        work_completed,
        materials_delivered,
        equipment_used,
        additional_notes,
        has_incident,
        created_at,
        updated_at
      )

      VALUES (
        $1,
        $2,
        $3::date,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        NOW(),
        NOW()
      )

      RETURNING
        id,
        project_name,
        engineer_name,

        TO_CHAR(
          date,
          'YYYY-MM-DD'
        ) AS date,

        work_on_site,
        supervisors,
        sub_contractors,
        total_work_hours,
        weather,
        temperature,
        work_completed,
        materials_delivered,
        equipment_used,
        additional_notes,
        has_incident,
        created_at,
        updated_at
    `;

    // ========================================================
    // VALUES
    // ========================================================

    const values = [
      project_name.trim(),

      engineer_name?.trim() ||
        'Site Engineer',

      date,

      work_on_site ?? 0,

      supervisors ?? 0,

      sub_contractors ?? 0,

      total_work_hours ?? '0',

      weather?.trim() ||
        'Sunny',

      temperature ?? null,

      work_completed?.trim() ||
        '',

      materials_delivered?.trim() ||
        '',

      equipment_used?.trim() ||
        '',

      additional_notes?.trim() ||
        '',

      has_incident ?? false
    ];

    // ========================================================
    // TERMINAL DATABASE INFORMATION
    // ========================================================

    console.log('\n📡 POSTGRESQL INSERT');
    console.log('────────────────────────────────────────────────────────────');

    console.log('🏗️ Project       :', values[0]);
    console.log('👷 Engineer      :', values[1]);
    console.log('📅 Date          :', values[2]);
    console.log('👷 Workers       :', values[3]);
    console.log('🧑‍💼 Supervisors :', values[4]);
    console.log('🏢 Subcontractors:', values[5]);
    console.log('⏱️ Work Hours    :', values[6]);
    console.log('🌤️ Weather       :', values[7]);
    console.log('🌡️ Temperature   :', values[8]);
    console.log('⚠️ Incident      :', values[13]);

    console.log('\n⏳ Inserting time log into PostgreSQL...');

    // ========================================================
    // EXECUTE INSERT
    // ========================================================

    const { rows } = await pool.query(
      query,
      values
    );

    const createdLog = rows[0];

    const duration =
      Date.now() - startTime;

    // ========================================================
    // RESPONSE
    // ========================================================

    const apiResponse = {
      success: true,
      message: 'Time log created successfully.',
      data: createdLog
    };

    // ========================================================
    // SUCCESS TERMINAL
    // ========================================================

    console.log('\n✅ TIME LOG CREATED SUCCESSFULLY');
    console.log('────────────────────────────────────────────────────────────');

    console.log('🟢 HTTP Status : 201 Created');
    console.log('🆔 Time Log ID :', createdLog.id);
    console.log('🏗️ Project     :', createdLog.project_name);
    console.log('👷 Engineer    :', createdLog.engineer_name);
    console.log('📅 Date        :', createdLog.date);
    console.log(`⚡ Duration    : ${duration}ms`);

    // ========================================================
    // TABLE
    // ========================================================

    console.log('\n📊 CREATED TIME LOG');
    console.log('────────────────────────────────────────────────────────────');

    console.table([
      {
        ID: createdLog.id,
        Project: createdLog.project_name,
        Engineer: createdLog.engineer_name,
        Date: createdLog.date,
        Workers: createdLog.work_on_site,
        Supervisors: createdLog.supervisors,
        Subcontractors: createdLog.sub_contractors,
        Hours: createdLog.total_work_hours,
        Weather: createdLog.weather,
        Temperature: createdLog.temperature,
        Incident:
          createdLog.has_incident
            ? 'YES'
            : 'NO'
      }
    ]);

    // ========================================================
    // DISPLAY RESPONSE JSON
    // ========================================================

    console.log('\n📤 API RESPONSE JSON');
    console.log('────────────────────────────────────────────────────────────');

    console.log(
      JSON.stringify(
        apiResponse,
        null,
        2
      )
    );

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🏁 [TIME LOGS API] POST REQUEST COMPLETED');
    console.log('════════════════════════════════════════════════════════════\n');

    // ========================================================
    // SEND RESPONSE
    // ========================================================

    return res
      .status(201)
      .json(apiResponse);

  } catch (err) {
    const duration =
      Date.now() - startTime;

    // ========================================================
    // ERROR
    // ========================================================

    const errorResponse = {
      success: false,
      message: 'Failed to create time log.',
      error: err.message
    };

    console.error('\n❌ TIME LOG CREATION FAILED');
    console.error('────────────────────────────────────────────────────────────');

    console.error('🌐 Method          :', req.method);
    console.error('🔗 Endpoint        :', req.originalUrl);
    console.error('🔴 HTTP Status     : 500');
    console.error('❌ Error Message   :', err.message);
    console.error('🐘 PostgreSQL Code :', err.code || 'N/A');

    if (err.detail) {
      console.error('📋 PostgreSQL Detail:', err.detail);
    }

    if (err.hint) {
      console.error('💡 PostgreSQL Hint:', err.hint);
    }

    if (err.constraint) {
      console.error('🔒 Constraint:', err.constraint);
    }

    console.error(`⚡ Failed after ${duration}ms`);

    console.error('\n📤 ERROR RESPONSE');
    console.error('────────────────────────────────────────────────────────────');

    console.error(
      JSON.stringify(
        errorResponse,
        null,
        2
      )
    );

    console.error('\n════════════════════════════════════════════════════════════');
    console.error('❌ [TIME LOGS API] POST REQUEST FAILED');
    console.error('════════════════════════════════════════════════════════════\n');

    return res
      .status(500)
      .json(errorResponse);
  }
};