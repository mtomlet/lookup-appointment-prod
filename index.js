/**
 * Lookup Appointment - PRODUCTION (Phoenix Encanto)
 *
 * Railway-deployable endpoint for Retell AI
 * Looks up customer appointments by phone
 *
 * PRODUCTION CREDENTIALS - DO NOT USE FOR TESTING
 * Location: Keep It Cut - Phoenix Encanto (201664)
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

    // Step 1: Find client by phone or email
    const clientsRes = await axios.get(
      `${CONFIG.API_URL}/clients?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
      { headers: { Authorization: `Bearer ${authToken}` }}
    );

    const clients = clientsRes.data.data || clientsRes.data;
    const client = clients.find(c => {
      if (phone) {
        const cleanPhone = normalizePhone(phone);
        const clientPhone = normalizePhone(c.primaryPhoneNumber);
        return clientPhone === cleanPhone;
      }
      if (email) {
        return c.emailAddress?.toLowerCase() === email.toLowerCase();
      }
      return false;
    });

    if (!client) {
      return res.json({
        success: true,
        found: false,
        appointments: [],
        message: 'No client found with that phone number or email'
      });
    }

    console.log('PRODUCTION Client found:', client.firstName, client.lastName, client.clientId);

    // Step 2: Get client's appointments
    const appointmentsRes = await axios.get(
      `${CONFIG.API_URL}/book/client/${client.clientId}/services?TenantId=${CONFIG.TENANT_ID}&LocationId=${CONFIG.LOCATION_ID}`,
      { headers: { Authorization: `Bearer ${authToken}` }}
    );

    const allAppointments = appointmentsRes.data.data || appointmentsRes.data;

    // Step 3: Filter for upcoming appointments
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const upcomingAppointments = allAppointments.filter(apt => {
      const aptTime = new Date(apt.startTime);
      return (aptTime > now || aptTime >= startOfToday) && !apt.isCancelled;
    });

    // Step 4: Format response
    const formattedAppointments = upcomingAppointments.map(apt => ({
      appointment_id: apt.appointmentId,
      appointment_service_id: apt.appointmentServiceId,
      datetime: apt.startTime,
      end_time: apt.servicingEndTime,
      service_id: apt.serviceId,
      stylist_id: apt.employeeId,
      concurrency_check: apt.concurrencyCheckDigits,
      status: apt.isCancelled ? 'cancelled' : 'confirmed'
    }));

    res.json({
      success: true,
      found: true,
      client_name: `${client.firstName} ${client.lastName}`,
      client_id: client.clientId,
      appointments: formattedAppointments,
      total: formattedAppointments.length,
      message: `Found ${formattedAppointments.length} upcoming appointment(s)`
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
