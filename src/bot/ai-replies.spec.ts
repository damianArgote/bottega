import { demoRequestSummary } from './ai-replies.js';

describe('demoRequestSummary', () => {
  it('lists the request, says it is fictitious and how to get back to the business bot', () => {
    const text = demoRequestSummary(
      {
        customerName: 'Juan',
        service: 'Corte de pelo',
        preferredDate: 'sábado',
        preferredTime: '11:00',
      },
      'Barbería X',
      'Lola, IA de Lola',
    );

    expect(text).toContain('Barbería X');
    expect(text).toContain('• Nombre: Juan');
    expect(text).toContain('FICTICIA');
    expect(text).toContain('"salir" para volver a hablar con Lola, IA de Lola');
    expect(text).not.toContain('BotSuite');
  });
});
