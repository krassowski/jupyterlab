import { Widget } from '@lumino/widgets';
import { Message } from '@lumino/messaging';

const RESIZE_HANDLE_CLASS = 'jp-CellResizeHandle';

const CELL_RESIZED_CLASS = 'jp-mod-resizedCell';

export class ResizeHandle extends Widget {
  private _isActive: boolean = false;
  private _isDragging: boolean = false;

  constructor(protected targetNode: HTMLElement) {
    super();
    this.addClass(RESIZE_HANDLE_CLASS);
  }

  protected onAfterAttach(msg: Message) {
    super.onAfterAttach(msg);
    this.node.addEventListener('dblclick', this);
    this.node.addEventListener('mousedown', this);
  }

  protected onAfterDetach(msg: Message) {
    super.onAfterAttach(msg);
    this.node.removeEventListener('dblclick', this);
    this.node.removeEventListener('mousedown', this);
  }

  /**
   * Handle the DOM events for the widget.
   *
   * @param event - The DOM event sent to the widget.
   *
   */
  handleEvent(event: Event): void {
    switch (event.type) {
      case 'dblclick':
        this.targetNode.classList.remove(CELL_RESIZED_CLASS);
        this.targetNode.style.gridTemplateColumns = '';
        this._isActive = false;
        break;
      case 'mousedown':
        this._isDragging = true;
        if (!this._isActive) {
          this.targetNode.classList.add(CELL_RESIZED_CLASS);
          this._isActive = true;
        }
        window.addEventListener('mousemove', this);
        window.addEventListener('mouseup', this);
        break;
      case 'mousemove':
        if (!this._isActive || !this._isDragging) {
          return;
        }
        this.targetNode.style.gridTemplateColumns =
          (event as MouseEvent).clientX -
          this.targetNode.getBoundingClientRect().x +
          'px 1fr';
        break;
      case 'mouseup':
        this._isDragging = false;
        window.removeEventListener('mousemove', this);
        window.removeEventListener('mouseup', this);
        break;
      default:
        break;
    }
  }
}
