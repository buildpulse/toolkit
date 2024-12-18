import {S3ClientConfig} from '@aws-sdk/client-s3'
import {Artifact, DeleteArtifactResponse} from '../shared/interfaces'

export type S3Config = S3ClientConfig & {
  bucket: string
}

export interface IS3ArtifactManager {
  listArtifacts(): Promise<Artifact[]>
  getArtifact(name: string): Promise<Artifact>
  deleteArtifact(artifactId: string): Promise<DeleteArtifactResponse>
  createArtifact(name: string): Promise<{uploadUrl: string; artifactId: number}>
  uploadArtifact(key: string, stream: any): Promise<{uploadSize?: number; sha256Hash?: string; uploadId?: string}>
  finalizeArtifact(key: string, uploadId: string): Promise<void>
  getSignedDownloadUrl(key: string): Promise<string>
  clone(): Promise<IS3ArtifactManager>
}
