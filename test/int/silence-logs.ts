import { Logger } from '@nestjs/common';

// Keep integration output readable; log content is asserted in unit tests.
Logger.overrideLogger(false);
