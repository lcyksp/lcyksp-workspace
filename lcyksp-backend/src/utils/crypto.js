import crypto from 'crypto';

var ALGORITHM = 'aes-256-cbc';

var KEY = Buffer.from([
  0x6c, 0x63, 0x79, 0x6b, 0x73, 0x70, 0x2d, 0x6d,
  0x61, 0x73, 0x74, 0x65, 0x72, 0x2d, 0x6b, 0x65,
  0x79, 0x2d, 0x33, 0x32, 0x62, 0x79, 0x74, 0x65,
  0x2d, 0x32, 0x30, 0x32, 0x36, 0x21, 0x21, 0x21,
]);

var IV = Buffer.from([
  0x6c, 0x63, 0x79, 0x6b, 0x73, 0x70, 0x2d, 0x69,
  0x76, 0x2d, 0x31, 0x36, 0x62, 0x79, 0x74, 0x65,
]);

export function encrypt(text) {
  try {
    var cipher = crypto.createCipheriv(ALGORITHM, KEY, IV);
    var encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return encrypted.toString('hex');
  } catch (e) {
    return '';
  }
}

export function decrypt(hexString) {
  try {
    var decipher = crypto.createDecipheriv(ALGORITHM, KEY, IV);
    var decrypted = Buffer.concat([decipher.update(Buffer.from(hexString, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return '';
  }
}
