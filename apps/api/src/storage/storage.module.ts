import { Module } from '@nestjs/common';
import { PrivateAssetStore } from './private-asset-store.js';

@Module({ providers: [PrivateAssetStore], exports: [PrivateAssetStore] })
export class StorageModule {}
