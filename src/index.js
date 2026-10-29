import './quiet.js';
import { startWhatsApp } from './whatsapp.js';
import { startContextMaintenance, flushContext } from './context/service.js';

startContextMaintenance();
process.on('exit', flushContext);
startWhatsApp();
