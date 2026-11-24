import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { StorageAdminsService } from './admins.service';
import { DbStorageConnectorFactory, STORAGE_CONNECTORS, type StorageConnectorFactory } from './connector-factory';
import { DestinationsService } from './destinations.service';
import { ManifestService } from './manifest';
import { SourceAreaMoveService } from './relocate';
import { StorageController } from './storage.controller';
import { StorageSettingsService } from './settings.service';
import { StorageSummaryService } from './summary.service';

@Module({})
export class StorageModule {
  /** `connectors` replaces the real factory in tests only. */
  static register(connectors?: StorageConnectorFactory): DynamicModule {
    const factory: Provider = connectors
      ? { provide: STORAGE_CONNECTORS, useValue: connectors }
      : { provide: STORAGE_CONNECTORS, useClass: DbStorageConnectorFactory };
    return {
      module: StorageModule,
      global: true,
      controllers: [StorageController],
      providers: [StorageSettingsService, DestinationsService, StorageAdminsService, SourceAreaMoveService, ManifestService, StorageSummaryService, factory],
      exports: [StorageSettingsService, DestinationsService, StorageAdminsService, STORAGE_CONNECTORS, StorageSummaryService],
    };
  }
}
