import { InjectionToken } from '@angular/core'
import { BehaviorSubject } from 'rxjs'

/** Per-tab token: true when this canvas instance is the active tab. */
export const IS_ACTIVE_TAB = new InjectionToken<BehaviorSubject<boolean>>('IS_ACTIVE_TAB')

/**
 * Token for TabManagerService — breaks circular dependency:
 *   tab-manager.service.ts → NetopsCanvasComponent → TabManagerService
 * Components inject this token instead of importing TabManagerService directly.
 */
export const TAB_MANAGER = new InjectionToken<any>('TAB_MANAGER')
