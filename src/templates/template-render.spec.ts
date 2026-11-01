import {
  renderTemplate,
  TemplateValuesError,
  templateVariables,
  unsupportedReason,
} from './template-render.js';

const reminder = [
  { type: 'HEADER', format: 'TEXT', text: 'Turno de {{1}}' },
  {
    type: 'BODY',
    text: 'Hola {{1}}, te esperamos el {{2}} a las {{3}}. ¡Gracias {{1}}!',
    example: { body_text: [['Ana', 'jueves', '10:00']] },
  },
  { type: 'FOOTER', text: 'Peluquería Sol' },
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Confirmo' },
      {
        type: 'URL',
        text: 'Ver turno',
        url: 'https://sol.example/turnos/{{1}}',
        example: ['https://sol.example/turnos/abc'],
      },
    ],
  },
];

describe('templateVariables', () => {
  it('lists header, body and URL button variables in send order, each once', () => {
    expect(templateVariables(reminder)).toEqual([
      { key: 'header.1', component: 'header', name: '1', example: null },
      { key: 'body.1', component: 'body', name: '1', example: 'Ana' },
      { key: 'body.2', component: 'body', name: '2', example: 'jueves' },
      { key: 'body.3', component: 'body', name: '3', example: '10:00' },
      {
        key: 'button.1.1',
        component: 'button',
        name: '1',
        example: 'https://sol.example/turnos/abc',
      },
    ]);
  });

  it('sorts positional placeholders by number', () => {
    const vars = templateVariables([{ type: 'BODY', text: '{{2}} y {{1}}' }]);
    expect(vars.map((v) => v.key)).toEqual(['body.1', 'body.2']);
  });

  it('reads named placeholders and their samples', () => {
    const vars = templateVariables([
      {
        type: 'BODY',
        text: 'Hola {{first_name}}, tu pedido {{order}}',
        example: {
          body_text_named_params: [
            { param_name: 'first_name', example: 'Ana' },
            { param_name: 'order', example: '123' },
          ],
        },
      },
    ]);
    expect(vars).toEqual([
      {
        key: 'body.first_name',
        component: 'body',
        name: 'first_name',
        example: 'Ana',
      },
      { key: 'body.order', component: 'body', name: 'order', example: '123' },
    ]);
  });

  it('is empty for a template without variables or with junk components', () => {
    expect(templateVariables([{ type: 'BODY', text: 'Hola' }])).toEqual([]);
    expect(templateVariables('nope')).toEqual([]);
  });
});

describe('unsupportedReason', () => {
  it('accepts text headers, quick replies, URL and phone buttons', () => {
    expect(unsupportedReason('UTILITY', reminder)).toBeNull();
  });

  it('rejects authentication templates, media headers and special buttons', () => {
    expect(unsupportedReason('AUTHENTICATION', [])).toMatch(/authentication/);
    expect(
      unsupportedReason('MARKETING', [{ type: 'HEADER', format: 'IMAGE' }]),
    ).toMatch(/image headers/);
    expect(
      unsupportedReason('MARKETING', [
        { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] },
      ]),
    ).toMatch(/copy_code buttons/);
  });
});

describe('renderTemplate', () => {
  const template = {
    name: 'recordatorio',
    language: 'es_AR',
    components: reminder,
  };

  it('builds the Meta components and the thread text with the values', () => {
    const rendered = renderTemplate(template, [
      'Ana',
      'Ana',
      'jueves',
      '10:00',
      'abc',
    ]);
    expect(rendered.message).toEqual({
      name: 'recordatorio',
      language: 'es_AR',
      components: [
        { type: 'header', parameters: [{ type: 'text', text: 'Ana' }] },
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Ana' },
            { type: 'text', text: 'jueves' },
            { type: 'text', text: '10:00' },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '1',
          parameters: [{ type: 'text', text: 'abc' }],
        },
      ],
    });
    expect(rendered.text).toBe(
      'Turno de Ana\n\nHola Ana, te esperamos el jueves a las 10:00. ¡Gracias Ana!\n\nPeluquería Sol',
    );
    expect(rendered.buttons).toEqual([{ id: 'template_0', title: 'Confirmo' }]);
  });

  it('sends named parameters with their names', () => {
    const rendered = renderTemplate(
      {
        name: 'pedido',
        language: 'es',
        components: [{ type: 'BODY', text: 'Hola {{first_name}}' }],
      },
      ['Ana'],
    );
    expect(rendered.message.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Ana', parameter_name: 'first_name' },
        ],
      },
    ]);
  });

  it('sends no components for a template without variables', () => {
    const rendered = renderTemplate(
      {
        name: 'hola',
        language: 'es',
        components: [{ type: 'BODY', text: 'Hola' }],
      },
      [],
    );
    expect(rendered.message.components).toEqual([]);
    expect(rendered.text).toBe('Hola');
  });

  it('names every missing or blank value', () => {
    let error: unknown;
    try {
      renderTemplate(template, ['Ana', ' ', 'jueves']);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TemplateValuesError);
    expect((error as TemplateValuesError).missing).toEqual([
      'body.1',
      'body.3',
      'button.1.1',
    ]);
  });

  it('rejects extra values and values WhatsApp refuses', () => {
    const simple = {
      name: 'hola',
      language: 'es',
      components: [{ type: 'BODY', text: 'Hola {{1}}' }],
    };
    expect(() => renderTemplate(simple, ['Ana', 'Beto'])).toThrow(
      TemplateValuesError,
    );
    expect(() => renderTemplate(simple, ['Ana\nBeto'])).toThrow(/line break/);
    expect(() => renderTemplate(simple, ['Ana     Beto'])).toThrow(/spaces/);
  });
});
