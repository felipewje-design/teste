// ========================================
// NETLIFY FUNCTION: Aprovar Saque Admin (EvoPay)
// Caminho: netlify/functions/admin-approve-withdraw.js
// ========================================

const admin = require('firebase-admin');
const axios = require('axios'); // Certifique-se de que 'axios' está no seu package.json

// Inicialização segura do Firebase
if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey.replace(/\\n/g, '\n')
      })
    });
  }
}

const db = admin.apps.length ? admin.firestore() : null;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Preflight request
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método não permitido' }) };

  try {
    // 1. Verificação de Segurança (Apenas Admin pode rodar isso)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    const expectedToken = process.env.ADMIN_SECRET_TOKEN;

    if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Não autorizado. Token de Admin inválido.' }) };
    }

    const { userId, withdrawId } = JSON.parse(event.body);

    if (!userId || !withdrawId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Faltam parâmetros de identificação' }) };
    }

    if (!db) throw new Error("Conexão com Banco de Dados falhou.");

    // 2. Buscar dados do saque no banco
    const withdrawalRef = db.collection('users').doc(userId).collection('withdrawals').doc(withdrawId);
    const withdrawalDoc = await withdrawalRef.get();

    if (!withdrawalDoc.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Solicitação de saque não encontrada' }) };
    }

    const withdrawalData = withdrawalDoc.data();

    // Impede de pagar um saque duas vezes
    if (withdrawalData.status !== 'processing' && withdrawalData.status !== 'pending') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Este saque já foi processado. Status atual: ${withdrawalData.status}` }) };
    }

    const evopayToken = process.env.EVOPAY_TOKEN;
    if (!evopayToken) throw new Error("Token EVOPAY_TOKEN não configurado.");

    // Usa netAmount se houver taxa calculada, senão usa amount normal
    const valorSaque = parseFloat(withdrawalData.netAmount || withdrawalData.amount);

    // 3. Acionar a EvoPay para realizar o PIX
    const evopayResponse = await axios.post('https://pix.evopay.cash/v1/withdraw', {
      amount: valorSaque,
      destinationKey: withdrawalData.pixKey,
      description: `Saque Admin Monety`
    }, {
      headers: { 'API-Key': evopayToken, 'Content-Type': 'application/json' }
    });

    const gatewayId = evopayResponse.data?.id || evopayResponse.data?.transactionId || 'N/A';

    // 4. Se o PIX deu certo, atualiza no Firestore
    await withdrawalRef.update({
      status: 'completed',
      gatewayTransactionId: gatewayId,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Atualiza histórico do usuário
    const transactionRef = db.collection('users').doc(userId).collection('transactions').doc();
    await transactionRef.set({
      type: 'withdrawal',
      amount: valorSaque,
      status: 'completed',
      description: `Saque PIX Aprovado (${withdrawalData.pixType})`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'PIX enviado com sucesso!', transactionId: gatewayId })
    };

  } catch (error) {
    console.error('Erro ao aprovar saque:', error.response?.data || error.message);
    return {
      statusCode: error.response?.status || 500,
      headers,
      body: JSON.stringify({ success: false, error: error.response?.data?.message || error.message })
    };
  }
};
