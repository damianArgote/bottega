import { createHmac } from 'node:crypto';
import { isValidSignature, signBody } from './signature.js';

const SECRET = 'unit-app-secret';
const BODY = Buffer.from('{"msg":"¡Hola! 🍕"}\n', 'utf8');

const hexSignature = (body: Buffer, secret = SECRET) =>
  createHmac('sha256', secret).update(body).digest('hex');

describe('isValidSignature', () => {
  it('accepts the HMAC-SHA256 of the raw bytes', () => {
    expect(isValidSignature(BODY, `sha256=${hexSignature(BODY)}`, SECRET)).toBe(
      true,
    );
  });

  it('accepts uppercase hex and matches signBody', () => {
    expect(
      isValidSignature(
        BODY,
        `sha256=${hexSignature(BODY).toUpperCase()}`,
        SECRET,
      ),
    ).toBe(true);
    expect(signBody(BODY, SECRET)).toBe(`sha256=${hexSignature(BODY)}`);
  });

  it('rejects a signature made with another secret', () => {
    expect(
      isValidSignature(BODY, `sha256=${hexSignature(BODY, 'other')}`, SECRET),
    ).toBe(false);
  });

  it('rejects a signature of a re-serialized body', () => {
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(BODY.toString())),
    );
    expect(
      isValidSignature(BODY, `sha256=${hexSignature(reserialized)}`, SECRET),
    ).toBe(false);
  });

  it.each([
    ['missing header', undefined],
    ['empty header', ''],
    ['no prefix', 'abc'],
    ['sha1 prefix', `sha1=${hexSignature(BODY)}`],
    ['short hex', 'sha256=abcd'],
    ['non-hex', `sha256=${'z'.repeat(64)}`],
  ])('rejects %s', (_label, header) => {
    expect(isValidSignature(BODY, header, SECRET)).toBe(false);
  });

  it('rejects a missing raw body', () => {
    expect(
      isValidSignature(undefined, `sha256=${hexSignature(BODY)}`, SECRET),
    ).toBe(false);
  });
});
