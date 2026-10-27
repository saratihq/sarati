import type { IncomingHttpHeaders } from 'node:http';

import { decodeInboundBody } from './inbound-body';

const decode = (body: string | Buffer, contentType?: string, headers: IncomingHttpHeaders = {}): unknown =>
  decodeInboundBody(typeof body === 'string' ? Buffer.from(body) : body, {
    ...headers,
    'content-type': contentType,
  });

const thrown = (body: string | Buffer, contentType?: string): unknown => {
  try {
    decode(body, contentType);
  } catch (err) {
    return err;
  }
  return null;
};

const FORM = 'application/x-www-form-urlencoded';

describe('decodeInboundBody', () => {
  it('an empty body is no body, whatever its type', () => {
    expect(decode('', 'application/json')).toBeUndefined();
    expect(decode('', 'application/octet-stream')).toBeUndefined();
    expect(decode('')).toBeUndefined();
  });

  it('JSON and every +json type parse to any JSON value, scalars included', () => {
    expect(decode('{"a":1}', 'application/json; charset=utf-8')).toEqual({ a: 1 });
    expect(decode('[1,2]', 'application/vnd.github+json')).toEqual([1, 2]);
    expect(decode('42', 'Application/JSON')).toBe(42);
    expect(decode('"ping"', 'application/json')).toBe('ping');
    expect(decode('null', 'application/json')).toBeNull();
  });

  it('a UTF-8 byte-order mark does not break JSON', () => {
    expect(decode('﻿{"a":1}', 'application/json')).toEqual({ a: 1 });
  });

  it('form fields decode flat, a repeated field to every value in order', () => {
    expect(decode('a=1&b=two+words&b=%26&c=&&d', FORM)).toEqual({
      a: '1',
      b: ['two words', '&'],
      c: '',
      d: '',
    });
    expect(decode('n=%E2%82%AC+%2B1&%zz=%4', FORM)).toEqual({ n: '€ +1', '%zz': '%4' });
  });

  it('form fields are read in the declared charset, escaped or not', () => {
    expect(decode('first_name=Jos%E9', `${FORM}; charset=windows-1252`)).toEqual({ first_name: 'José' });
    expect(decode(Buffer.from('n=Jos\xe9', 'latin1'), `${FORM}; charset=iso-8859-1`)).toEqual({ n: 'José' });
  });

  it('a form field named __proto__ is an ordinary field', () => {
    const fields = decode('__proto__=x&__proto__=y', FORM) as object;
    expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(fields, '__proto__')?.value).toEqual(['x', 'y']);
  });

  it('a GitHub form delivery is its event, and any other form keeps its fields', () => {
    const envelope = 'payload=%7B%22action%22%3A%22opened%22%7D';
    expect(decode(envelope, FORM, { 'x-github-event': 'issues' })).toEqual({ action: 'opened' });
    expect(decode(envelope, FORM)).toEqual({ payload: '{"action":"opened"}' });
    expect(decode(`${envelope}&x=1`, FORM, { 'x-github-event': 'issues' })).toEqual({
      payload: '{"action":"opened"}',
      x: '1',
    });
  });

  it('text and XML are strings, read in their declared charset', () => {
    expect(decode('hello', 'text/plain')).toBe('hello');
    expect(decode('hi', 'text/plain; charset=')).toBe('hi');
    expect(decode('<a/>', 'application/xml')).toBe('<a/>');
    expect(decode('<a/>', 'application/atom+xml')).toBe('<a/>');
    expect(decode(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset="ISO-8859-1"')).toBe('café');
  });

  it('a body with no Content-Type is read as UTF-8 text', () => {
    expect(decode('ping')).toBe('ping');
    expect(decode('{"a":1}')).toBe('{"a":1}');
  });

  it('refuses what it cannot represent with 415, and broken JSON with 400', () => {
    expect(thrown('x', 'application/octet-stream')).toMatchObject({
      name: 'DomainError',
      status: 415,
      message: 'Unsupported Content-Type "application/octet-stream": send JSON, form fields or text',
    });
    expect(thrown('x', 'multipart/form-data; boundary=b')).toMatchObject({
      name: 'DomainError',
      status: 415,
    });
    expect(thrown(Buffer.from([0x63, 0xe9]))).toMatchObject({
      status: 415,
      message: 'A body with no Content-Type must be UTF-8 text',
    });
    expect(thrown('x', 'text/plain; charset=klingon')).toMatchObject({
      status: 415,
      message: 'Unsupported charset "klingon"',
    });
    expect(thrown('{', 'application/json')).toMatchObject({
      status: 400,
      message: 'The request body is not valid JSON',
    });
  });
});
