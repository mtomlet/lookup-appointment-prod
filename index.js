/**
 * Lookup Appointment - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Looks up customer appointments by phone
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
 *
 * UPDATED: Now also returns appointments for linked profiles (minors/guests)
 */

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// PRODUCTION Meevo API Configuration
const CONFIG = {
  AUTH_URL: 'https://marketplace.meevo.com/oauth2/token',
  API_URL: 'https://na1pub.meevo.com/publicapi/v1',
  CLIENT_ID: 'f6a5046d-208e-4829-9941-034ebdd2aa65',
  CLIENT_SECRET: '2f8feb2e-51f5-40a3-83af-3d4a6a454abe',
  TENANT_ID: '200507',
  LOCATION_ID: '201664'  // Phoenix Encanto
};

let token = null;
let tokenExpiry = null;

function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 11 && cleaned.startsWith('1')) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

async function getToken() {
  if (token && tokenExpiry && Date.now() < tokenExpiry - 300000) return token;

  const res = await axios.post(CONFIG.AUTH_URL, {
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET
  });

  token = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return token;
}

/**
 * Find linked profiles (minors/guests) for a guardian
 * Searches recent clients first (where new linked profiles are)
 * Only checks clients without phone numbers (likely minors/dependents)
 */
async function findLinkedProfiles(authToken, guardianId, locationId) {
  const linkedProfiles = [];
  const seenIds = new Set();

  console.log(`PRODUCTION: Finding linked profiles for guardian: ${guardianId}`);

  // Search in priority order: recent first, then older
  const PAGE_RANGES = [
    { start: 150, end: 200 },  // Most recent (page 150-200)
    { start: 100, end: 150 },  // Recent (page 100-150)
    { start: 50, end: 100 },   // Middle (page 50-100)
    { start: 1, end: 50 }      // Oldest (page 1-50)
  ];

  for (const range of PAGE_RANGES) {
    for (let batchStart = range.start; batchStart < range.end; batchStart += 10) {
      const pagePromises = [];

      for (let page = batchStart; page < batchStart + 10 && page <= range.end; page++) {
        pagePromises.push(
          axios.get(
            `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${locationId}&PageNumber=${page}&ItemsPerPage=100`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 3000 }
          ).catch(() => ({ data: { data: [] } }))
        );
      }

      const results = await Promise.all(pagePromises);
      let emptyPages = 0;
      const candidateClients = [];

      for (const result of results) {
        const clients = result.data?.data || [];
        if (clients.length === 0) {
          emptyPages++;
          continue;
        }

        for (const c of clients) {
          if (seenIds.has(c.clientId)) continue;
          // Only check clients WITHOUT a phone (likely minors/dependents)
          if (!c.primaryPhoneNumber) {
            candidateClients.push(c);
          }
        }
      }

      // Check candidates in parallel batches of 50
      for (let i = 0; i < candidateClients.length; i += 50) {
        const batch = candidateClients.slice(i, i + 50);
        const detailPromises = batch.map(c =>
          axios.get(
            `${CONFIG.API_URL}/client/${c.clientId}?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
            { headers: { Authorization: `Bearer ${authToken}` }, timeout: 2000 }
          ).catch(() => null)
        );

        const detailResults = await Promise.all(detailPromises);

        for (const detailRes of detailResults) {
          if (!detailRes) continue;
          const client = detailRes.data?.data || detailRes.data;
          if (!client || seenIds.has(client.clientId)) continue;

          seenIds.add(client.clientId);

          if (client.guardianId === guardianId) {
            linkedProfiles.push({
              client_id: client.clientId,
              first_name: client.firstName,
              last_name: client.lastName,
              name: `${client.firstName} ${client.lastName}`,
              is_minor: client.isMinor || false
            });
            console.log(`PRODUCTION: Found linked profile: ${client.firstName} ${client.lastName}`);
          }
        }
      }

      // If all pages empty, we've reached the end of this range
      if (emptyPages >= 10) {
        break;
      }
    }

    // If we found linked profiles in recent pages, we can stop
    if (linkedProfiles.length > 0) {
      console.log(`PRODUCTION: Found profiles in range ${range.start}-${range.end}, stopping search`);
      break;
    }
  }

  console.log(`PRODUCTION: Found ${linkedProfiles.length} linked profiles total`);
  return linkedProfiles;
}

/**
 * Get appointments for a specific client
 */
async function getClientAppointments(authToken, clientId, clientName, locationId) {
  try {
    const appointmentsRes = await axios.get(
      `${CONFIG.API_URL}/book/client/${clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${locationId}`,
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 5000 }
    );

    const allAppointments = appointmentsRes.data?.data || appointmentsRes.data || [];

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    return allAppointments
      .filter(apt => {
        const aptTime = new Date(apt.startTime);
        return (aptTime > now || aptTime >= startOfToday) && !apt.isCancelled;
      })
      .map(apt => ({
        appointment_id: apt.appointmentId,
        appointment_service_id: apt.appointmentServiceId,
        datetime: apt.startTime,
        end_time: apt.servicingEndTime,
        service_id: apt.serviceId,
        stylist_id: apt.employeeId,
        concurrency_check: apt.concurrencyCheckDigits,
        status: apt.isCancelled ? 'cancelled' : 'confirmed',
        client_id: clientId,
        client_name: clientName
      }));
  } catch (error) {
    console.log(`Error getting appointments for ${clientName}:`, error.message);
    return [];
  }
}

app.post('/lookup', async (req, res) => {
  try {
    const { phone, email } = req.body;

    if (!phone && !email) {
      return res.json({
        success: false,
        error: 'Please provide phone or email'
      });
    }

    const authToken = await getToken();

    // Step 1: Find client by phone or email with parallel pagination
    const cleanPhone = phone ? normalizePhone(phone) : null;
    const cleanEmail = email?.toLowerCase();
    let foundClient = null;

    const PAGES_PER_BATCH = 10;
    const ITEMS_PER_PAGE = 100;
    const MAX_BATCHES = 20;

    for (let batch = 0; batch < MAX_BATCHES && !foundClient; batch++) {
      const startPage = batch * PAGES_PER_BATCH + 1;
      const pagePromises = [];

      for (let i = 0; i < PAGES_PER_BATCH; i++) {
        const page = startPage + i;
        pagePromises.push(
          axios.get(
            `${CONFIG.API_URL}/clients?tenantid=${CONFIG.TENANT_ID}&locationid=${CONFIG.LOCATION_ID}&PageNumber=${page}&ItemsPerPage=${ITEMS_PER_PAGE}`,
            { headers: { Authorization: `Bearer ${authToken}` } }
          ).catch(() => ({ data: { data: [] } }))
        );
      }

      const results = await Promise.all(pagePromises);
      let emptyPages = 0;

      for (const result of results) {
        const clients = result.data?.data || [];
        if (clients.length === 0) emptyPages++;

        for (const c of clients) {
          if (cleanPhone) {
            const clientPhone = normalizePhone(c.primaryPhoneNumber);
            if (clientPhone === cleanPhone) {
              foundClient = c;
              break;
            }
          }
          if (cleanEmail && c.emailAddress?.toLowerCase() === cleanEmail) {
            foundClient = c;
            break;
          }
        }
        if (foundClient) break;
      }

      if (emptyPages === PAGES_PER_BATCH) break;
    }

    if (!foundClient) {
      return res.json({
        success: true,
        found: false,
        appointments: [],
        message: 'No client found with that phone number or email'
      });
    }

    console.log('PRODUCTION Client found:', foundClient.firstName, foundClient.lastName, foundClient.clientId);

    // Step 2: Get caller's appointments
    const callerName = `${foundClient.firstName} ${foundClient.lastName}`;
    const callerAppointments = await getClientAppointments(
      authToken,
      foundClient.clientId,
      callerName,
      CONFIG.LOCATION_ID
    );

    // Step 3: Find linked profiles
    console.log('PRODUCTION: Finding linked profiles...');
    const linkedProfiles = await findLinkedProfiles(authToken, foundClient.clientId, CONFIG.LOCATION_ID);
    console.log('PRODUCTION: Found', linkedProfiles.length, 'linked profiles');

    // Step 4: Get appointments for each linked profile
    let linkedAppointments = [];
    for (const profile of linkedProfiles) {
      const profileAppointments = await getClientAppointments(
        authToken,
        profile.client_id,
        profile.name,
        CONFIG.LOCATION_ID
      );
      linkedAppointments = linkedAppointments.concat(profileAppointments);
    }

    // Step 5: Combine and sort all appointments
    const allAppointments = [...callerAppointments, ...linkedAppointments];
    allAppointments.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    console.log('PRODUCTION: Total appointments:', callerAppointments.length, '(caller) +', linkedAppointments.length, '(linked) =', allAppointments.length);

    res.json({
      success: true,
      found: true,
      client_name: callerName,
      client_id: foundClient.clientId,
      appointments: allAppointments,
      total: allAppointments.length,
      linked_profiles: linkedProfiles.map(p => ({
        client_id: p.client_id,
        name: p.name,
        is_minor: p.is_minor
      })),
      message: `Found ${allAppointments.length} upcoming appointment(s)${linkedProfiles.length > 0 ? ` (including ${linkedAppointments.length} for linked profiles)` : ''}`
    });

  } catch (error) {
    console.error('PRODUCTION Lookup error:', error.message);
    res.json({
      success: false,
      error: error.response?.data?.error?.message || error.message
    });
  }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  environment: 'PRODUCTION',
  location: 'Phoenix Encanto',
  service: 'Lookup Appointment'
}));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`PRODUCTION Lookup server running on port ${PORT}`));
