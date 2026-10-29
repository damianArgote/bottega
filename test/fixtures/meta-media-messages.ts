/**
 * Inbound messages with attachments as the WhatsApp Cloud API webhook sends
 * them (`entry[].changes[].value.messages[]`), one per type. Ids are fake.
 */
const base = (id: string, type: string) => ({
  from: '5491100001234',
  id: `wamid.${id}`,
  timestamp: '1760140800',
  type,
});

export const META_VOICE_NOTE = {
  ...base('voice', 'audio'),
  audio: {
    mime_type: 'audio/ogg; codecs=opus',
    sha256: 'Z3Vlc3Mtc2hhMjU2',
    id: '1234567890001',
    voice: true,
  },
};

export const META_IMAGE = {
  ...base('image', 'image'),
  image: {
    caption: '¿Tienen esta torta?',
    mime_type: 'image/jpeg',
    sha256: 'aW1hZ2Utc2hhMjU2',
    id: '1234567890002',
  },
};

export const META_DOCUMENT = {
  ...base('document', 'document'),
  document: {
    caption: 'Mi pedido',
    filename: 'pedido.pdf',
    mime_type: 'application/pdf',
    sha256: 'ZG9jLXNoYTI1Ng==',
    id: '1234567890003',
  },
};

export const META_VIDEO = {
  ...base('video', 'video'),
  video: {
    mime_type: 'video/mp4',
    sha256: 'dmlkZW8tc2hhMjU2',
    id: '1234567890004',
  },
};

export const META_STICKER = {
  ...base('sticker', 'sticker'),
  sticker: {
    mime_type: 'image/webp',
    sha256: 'c3RpY2tlci1zaGEyNTY=',
    id: '1234567890005',
    animated: false,
  },
};

export const META_LOCATION = {
  ...base('location', 'location'),
  location: {
    latitude: -34.6301,
    longitude: -58.4637,
    name: 'KUBBO',
    address: 'Presidente Camilo Tenorio 2036',
  },
};
