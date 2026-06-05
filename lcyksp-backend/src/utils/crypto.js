import crypto from 'crypto';

var ALGORITHM = 'aes-256-gcm';
var IV_LENGTH = 16;

var MASTER_KEY = (function () {
  var key = process.env.MASTER_ENCRYPT_KEY || 'lcyksp-master-key-32byte-2026-dev!!';
  return crypto.createHash('sha256').update(key).digest();
})();

export function encrypt(plaintext) {
  var iv = crypto.randomBytes(IV_LENGTH);
  var cipher = crypto.createCipheriv(ALGORITHM, MASTER_KEY, iv);
  var encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  var authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

export function decrypt(encryptedHex, ivHex, authTagHex) {
  var iv = Buffer.from(ivHex, 'hex');
  var authTag = Buffer.from(authTagHex, 'hex');
  var encrypted = Buffer.from(encryptedHex, 'hex');
  var decipher = crypto.createDecipheriv(ALGORITHM, MASTER_KEY, iv);
  decipher.setAuthTag(authTag);
  var decrypted = decipher.update(encrypted);
  return decrypted.toString('utf8');
}
