const pool = require('../db');


// ============================================================
// GET ALL PROJECTS ACCESSIBLE BY CURRENT USER
//
// A user can see a project when:
//
// 1. They own the project
// OR
// 2. They joined the project
//
// NOTE:
// project_members.project_id references projects.code
// ============================================================

const getAll = async (
  status,
  search,
  code,
  userId,
  userEmail
) => {

  if (!userId) {
    throw new Error(
      'User ID is required to fetch projects.'
    );
  }

  const conditions = [];

  const params = [
    userId,
    userEmail || null
  ];


  // ============================================================
  // PROJECT ACCESS
  //
  // Explicit casts prevent UUID/text type conflicts.
  // ============================================================

  conditions.push(`
    (
      p.owner_id = $1::uuid

      OR EXISTS (
        SELECT 1

        FROM project_members pm

        WHERE pm.project_id = p.code

          AND (
            pm.user_id::text = $1::text

            OR (
              $2::text IS NOT NULL

              AND LOWER(
                TRIM(pm.user_name::text)
              ) = LOWER(
                TRIM($2::text)
              )
            )
          )
      )
    )
  `);


  // ============================================================
  // STATUS FILTER
  // ============================================================

  if (
    status &&
    status !== 'All' &&
    status !== 'All Statuses'
  ) {

    params.push(status);

    conditions.push(
      `p.status ILIKE $${params.length}`
    );
  }


  // ============================================================
  // PROJECT CODE FILTER
  // ============================================================

  if (
    code &&
    code !== 'All' &&
    code !== 'All Projects'
  ) {

    params.push(code);

    conditions.push(
      `p.code ILIKE $${params.length}`
    );
  }


  // ============================================================
  // SEARCH FILTER
  // ============================================================

  if (
    search &&
    search.trim()
  ) {

    params.push(
      `%${search.trim()}%`
    );

    conditions.push(`
      (
        p.name ILIKE $${params.length}

        OR p.code ILIKE $${params.length}

        OR p.client ILIKE $${params.length}

        OR p.location ILIKE $${params.length}
      )
    `);
  }


  // ============================================================
  // WHERE
  // ============================================================

  const where =
    `WHERE ${conditions.join(' AND ')}`;


  // ============================================================
  // FINAL QUERY
  // ============================================================

  const query = `
    SELECT

      p.id,

      p.code,

      p.name,

      p.location,

      p.client,

      p.budget,

      p.phase,

      p.scope,

      p.status,

      p.owner_id,


      CASE

        WHEN p.owner_id = $1::uuid
          THEN 'owner'

        ELSE 'member'

      END AS access_type,


      TO_CHAR(
        p.start_date,
        'YYYY-MM-DD'
      ) AS start_date,


      TO_CHAR(
        p.end_date,
        'YYYY-MM-DD'
      ) AS end_date


    FROM projects p


    ${where}


    ORDER BY
      p.created_at DESC
  `;


  try {

    const { rows } =
      await pool.query(
        query,
        params
      );


    return rows;


  } catch (error) {

    console.error(
      '======================================'
    );

    console.error(
      '❌ PROJECT SERVICE getAll ERROR'
    );

    console.error(
      'MESSAGE:',
      error.message
    );

    console.error(
      'CODE:',
      error.code
    );

    console.error(
      'USER ID:',
      userId
    );

    console.error(
      'USER EMAIL:',
      userEmail
    );

    console.error(
      'QUERY:',
      query
    );

    console.error(
      'PARAMS:',
      params
    );

    console.error(
      '======================================'
    );


    throw error;
  }
};


// ============================================================
// GET ONE PROJECT BY CODE
//
// User must:
// - own project
// OR
// - be a joined project member
// ============================================================

const getByCode = async (
  code,
  userId,
  userEmail
) => {

  if (!userId) {

    throw new Error(
      'User ID is required to fetch project.'
    );
  }


  try {

    const { rows } =
      await pool.query(
        `
        SELECT

          p.id,

          p.code,

          p.name,

          p.location,

          p.client,

          p.budget,

          p.phase,

          p.scope,

          p.status,

          p.owner_id,


          CASE

            WHEN p.owner_id = $2::uuid
              THEN 'owner'

            ELSE 'member'

          END AS access_type,


          TO_CHAR(
            p.start_date,
            'YYYY-MM-DD'
          ) AS start_date,


          TO_CHAR(
            p.end_date,
            'YYYY-MM-DD'
          ) AS end_date


        FROM projects p


        WHERE p.code ILIKE $1


          AND (

            p.owner_id = $2::uuid


            OR EXISTS (

              SELECT 1

              FROM project_members pm


              WHERE pm.project_id = p.code


                AND (

                  pm.user_id::text =
                    $2::text


                  OR (

                    $3::text IS NOT NULL


                    AND LOWER(
                      TRIM(
                        pm.user_name::text
                      )
                    )

                    =

                    LOWER(
                      TRIM(
                        $3::text
                      )
                    )

                  )

                )

            )

          )


        LIMIT 1
        `,
        [
          code,
          userId,
          userEmail || null
        ]
      );


    return rows[0] || null;


  } catch (error) {

    console.error(
      '======================================'
    );

    console.error(
      '❌ PROJECT SERVICE getByCode ERROR'
    );

    console.error(
      'MESSAGE:',
      error.message
    );

    console.error(
      'CODE:',
      error.code
    );

    console.error(
      'PROJECT CODE:',
      code
    );

    console.error(
      'USER ID:',
      userId
    );

    console.error(
      'USER EMAIL:',
      userEmail
    );

    console.error(
      '======================================'
    );


    throw error;
  }
};


// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getAll,
  getByCode
};