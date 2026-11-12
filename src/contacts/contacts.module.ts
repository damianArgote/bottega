import { Module } from '@nestjs/common';
import { ContactTagsService } from './contact-tags.service.js';

/** Contact tags: the business's tags and the tags of each contact. */
@Module({
  providers: [ContactTagsService],
  exports: [ContactTagsService],
})
export class ContactsModule {}
